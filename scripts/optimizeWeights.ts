import fs from 'fs';
import path from 'path';

import { getModelWeights, saveModelWeightsToFile, ModelWeights } from '../src/lib/modelWeights';
import { computeModelV2 } from '../src/lib/modelV2';
import { getRaceDetails } from '../src/lib/netkeiba';
import { estimateFinishProbs } from '../src/lib/simulator';
import { fetchRaceResult, System } from '../src/lib/resultParser';

type RaceSpec = { raceId: string; system: System };

function arg(name: string, def?: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return def;
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}

function mean(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ece(probs: number[], labels: number[], bins = 10): number {
    const n = probs.length;
    if (n === 0) return 0;
    let e = 0;
    for (let b = 0; b < bins; b++) {
        const lo = b / bins;
        const hi = (b + 1) / bins;
        let cnt = 0, ps = 0, ys = 0;
        for (let i = 0; i < n; i++) {
            const p = probs[i];
            if ((b === 0 ? p >= lo : p > lo) && p <= hi) {
                cnt++;
                ps += p;
                ys += labels[i];
            }
        }
        if (cnt > 0) {
            e += (cnt / n) * Math.abs(ps / cnt - ys / cnt);
        }
    }
    return e;
}

function randn(): number {
    // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function softmax3(a: number, b: number, c: number): [number, number, number] {
    const ea = Math.exp(a), eb = Math.exp(b), ec = Math.exp(c);
    const s = ea + eb + ec;
    return [ea / s, eb / s, ec / s];
}

function makeRng(seed: number): () => number {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

async function evalWeightsOnSet(
    races: RaceSpec[],
    weights: Partial<ModelWeights>,
    opts: { mcIters: number; bins: number; lambdaBrierTop3: number; lambdaEceTop3: number; seed: number }
): Promise<{ obj: number; logloss: number; brierTop3: number; eceTop3: number; nRaces: number }> {
    let nRaces = 0;
    let ll = 0;
    const top3P: number[] = [];
    const top3Y: number[] = [];

    for (const r of races) {
        try {
            const result = await fetchRaceResult(r.raceId, r.system);
            if (!result || result.order.length === 0) continue;
            const top3Set = new Set(result.top3);
            const winner = result.order[0];

            const race = await getRaceDetails(r.raceId, r.system);
            if (!race) continue;

            const rng = makeRng(opts.seed ^ (parseInt(r.raceId.slice(-6), 10) || 0));
            const base = computeModelV2(race, { weightsOverride: weights });

            // pace mixture: Top3確率も線形合成（finishProbsで出す）
            const useMixture = (process.env.KEIBA_BACKTEST_USE_PACE_MIXTURE ?? '1') === '1';
            let winArr: number[] = [];
            let top3Arr: number[] = [];

            if (useMixture) {
                const pace = base.paceIndex;
                const paceShift = Number(process.env.KEIBA_PACE_SHIFT || '') || 0.6;
                const scale = Number(process.env.KEIBA_PACE_SOFTMAX_SCALE || '') || 1.2;
                const normalBias = Number(process.env.KEIBA_PACE_NORMAL_BIAS || '') || 0.8;
                const w = softmax3(-scale * pace, normalBias, +scale * pace);

                const slow = computeModelV2(race, { weightsOverride: weights, paceOverride: Math.max(-1, pace - paceShift) });
                const fast = computeModelV2(race, { weightsOverride: weights, paceOverride: Math.min(+1, pace + paceShift) });

                const slowF = estimateFinishProbs(slow.probs, opts.mcIters, rng);
                const normF = estimateFinishProbs(base.probs, opts.mcIters, rng);
                const fastF = estimateFinishProbs(fast.probs, opts.mcIters, rng);

                winArr = slowF.win.map((_, i) => w[0] * slowF.win[i] + w[1] * normF.win[i] + w[2] * fastF.win[i]);
                top3Arr = slowF.top3.map((_, i) => w[0] * slowF.top3[i] + w[1] * normF.top3[i] + w[2] * fastF.top3[i]);
            } else {
                const f = estimateFinishProbs(base.probs, opts.mcIters, rng);
                winArr = f.win;
                top3Arr = f.top3;
            }

            // logloss (winner)
            const idx = race.horses.findIndex(h => h.number === winner);
            if (idx < 0) continue;
            const pWin = clamp(winArr[idx], 1e-12, 1);
            ll += -Math.log(pWin);
            nRaces += 1;

            // Top3 calibration samples（全馬）
            race.horses.forEach((h, i) => {
                const p = clamp(top3Arr[i], 0, 1);
                const y = top3Set.has(h.number) ? 1 : 0;
                top3P.push(p);
                top3Y.push(y);
            });
        } catch {
            // skip errors
        }
    }

    if (nRaces === 0) {
        return { obj: Number.POSITIVE_INFINITY, logloss: Number.POSITIVE_INFINITY, brierTop3: 1, eceTop3: 1, nRaces: 0 };
    }

    const logloss = ll / nRaces;
    const brierTop3 = mean(top3P.map((p, i) => (p - top3Y[i]) ** 2));
    const eceTop3 = ece(top3P, top3Y, opts.bins);
    const obj = logloss + opts.lambdaBrierTop3 * brierTop3 + opts.lambdaEceTop3 * eceTop3;

    return { obj, logloss, brierTop3, eceTop3, nRaces };
}

function mutate(base: ModelWeights, sigma: number): ModelWeights {
    const w: ModelWeights = { ...base };

    // 係数は正であるべきなので log-space っぽく揺らす
    const mult = (x: number) => clamp(x * (1 + randn() * sigma), 0.0001, 3.0);

    w.form = mult(w.form);
    w.last3f = mult(w.last3f);
    w.dist = mult(w.dist);
    w.going = mult(w.going);
    w.styleScale = clamp(w.styleScale * (1 + randn() * sigma), 0.2, 3.0);
    w.jockey = clamp(w.jockey * (1 + randn() * sigma), 0.0, 0.3);
    w.trainer = clamp(w.trainer * (1 + randn() * sigma), 0.0, 0.3);
    w.insideBiasScale = clamp(w.insideBiasScale * (1 + randn() * sigma), 0.2, 3.0);
    w.frontBiasScale = clamp(w.frontBiasScale * (1 + randn() * sigma), 0.2, 3.0);
    w.paceScale = clamp(w.paceScale * (1 + randn() * sigma), 0.2, 3.0);

    return w;
}

async function main() {
    const file = arg('--data', path.join('data', 'backtest_races.json'))!;
    const races = JSON.parse(fs.readFileSync(file, 'utf-8')) as RaceSpec[];
    if (!Array.isArray(races) || races.length === 0) {
        console.log(`No races in ${file}. Fill it with past race ids first.`);
        process.exit(0);
    }

    const it = Number(arg('--iters', '120')) || 120;
    const sigma = Number(arg('--sigma', '0.15')) || 0.15;
    const mcIters = Number(arg('--mc', process.env.KEIBA_OPT_MC_ITERATIONS || '2000'));
    const bins = Number(arg('--bins', process.env.KEIBA_ECE_BINS || '10'));
    const seed = Number(arg('--seed', process.env.KEIBA_OPT_SEED || '777'));

    const lambdaBrierTop3 = Number(arg('--lambda_top3_brier', process.env.KEIBA_LAMBDA_TOP3_BRIER || '0.6'));
    const lambdaEceTop3 = Number(arg('--lambda_top3_ece', process.env.KEIBA_LAMBDA_TOP3_ECE || '1.2'));
    const outPath = arg('--out', path.join('data', 'modelWeights.json'))!;

    const base = getModelWeights(); // file + default
    let best = base;
    let bestEval = await evalWeightsOnSet(races, best, { mcIters, bins, lambdaBrierTop3, lambdaEceTop3, seed });

    console.log(`Start: obj=${bestEval.obj.toFixed(6)} logloss=${bestEval.logloss.toFixed(6)} brierTop3=${bestEval.brierTop3.toFixed(6)} eceTop3=${bestEval.eceTop3.toFixed(6)} N=${bestEval.nRaces}`);
    console.log(`base=${JSON.stringify(best)}`);

    for (let k = 1; k <= it; k++) {
        const cand = mutate(best, sigma);
        const ev = await evalWeightsOnSet(races, cand, { mcIters, bins, lambdaBrierTop3, lambdaEceTop3, seed });
        if (ev.obj < bestEval.obj) {
            bestEval = ev;
            best = cand;
            console.log(`[BEST] iter=${k} obj=${bestEval.obj.toFixed(6)} logloss=${bestEval.logloss.toFixed(6)} brierTop3=${bestEval.brierTop3.toFixed(6)} eceTop3=${bestEval.eceTop3.toFixed(6)} w=${JSON.stringify(best)}`);
        } else if (k % 10 === 0) {
            console.log(`[..] iter=${k} curBestObj=${bestEval.obj.toFixed(6)}`);
        }
    }

    saveModelWeightsToFile(best, outPath);
    console.log(`Saved best weights to ${outPath}`);
    console.log(`Best obj=${bestEval.obj.toFixed(6)} (logloss=${bestEval.logloss.toFixed(6)}, brierTop3=${bestEval.brierTop3.toFixed(6)}, eceTop3=${bestEval.eceTop3.toFixed(6)})`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
