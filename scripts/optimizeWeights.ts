import fs from 'fs';
import path from 'path';

import { getModelWeights, saveModelWeightsToFile, ModelWeights } from '../src/lib/modelWeights';
import { computeModelV2 } from '../src/lib/modelV2';
import { getRaceDetails } from '../src/lib/netkeiba';
import { estimateFinishProbs } from '../src/lib/simulator';
import { fetchRaceResult, RaceResult, System } from '../src/lib/resultParser';
import { Race } from '../src/lib/types';

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
        if (cnt > 0) e += (cnt / n) * Math.abs(ps / cnt - ys / cnt);
    }
    return e;
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

function randn(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function mutate(base: ModelWeights, sigma: number): ModelWeights {
    const w: ModelWeights = { ...base };
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

// ローカルキャッシュディレクトリ
function cacheDir(): string {
    return process.env.KEIBA_BT_CACHE_DIR || '.keiba_backtest_cache';
}

function cachePath(kind: 'race' | 'result', s: System, raceId: string): string {
    return path.join(cacheDir(), `${kind}_${s}_${raceId}.json`);
}

function readJsonIfExists<T>(p: string): T | null {
    try {
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
    } catch {
        return null;
    }
}

function writeJson(p: string, obj: unknown): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

// 事前ロード＋ローカルキャッシュ
async function preload(specs: RaceSpec[]): Promise<Array<{ spec: RaceSpec; race: Race; result: RaceResult }>> {
    const out: Array<{ spec: RaceSpec; race: Race; result: RaceResult }> = [];

    for (const s of specs) {
        const pr = cachePath('race', s.system, s.raceId);
        const ps = cachePath('result', s.system, s.raceId);
        let race = readJsonIfExists<Race>(pr);
        let result = readJsonIfExists<RaceResult>(ps);

        if (!race) {
            race = await getRaceDetails(s.raceId, s.system);
            if (race) writeJson(pr, race);
        }
        if (!result) {
            const r = await fetchRaceResult(s.raceId, s.system);
            if (r) {
                result = r;
                writeJson(ps, r);
            }
        }

        if (race && result && result.order.length > 0) {
            out.push({ spec: s, race, result });
        }
    }

    return out;
}

// 目的関数評価（ネットワークアクセスなし）
function evalObjective(
    dataset: Array<{ spec: RaceSpec; race: Race; result: RaceResult }>,
    weights: Partial<ModelWeights>,
    opts: {
        mcIters: number; bins: number; seed: number; useMixture: boolean;
        lambdaBrierTop2: number; lambdaEceTop2: number;
        lambdaBrierTop3: number; lambdaEceTop3: number;
    }
): { obj: number; logloss: number; brierTop2: number; eceTop2: number; brierTop3: number; eceTop3: number; nRaces: number } {
    let nRaces = 0;
    let ll = 0;
    const top2P: number[] = [];
    const top2Y: number[] = [];
    const top3P: number[] = [];
    const top3Y: number[] = [];

    for (const item of dataset) {
        const race = item.race;
        const result = item.result;
        const winner = result.order[0];
        // Top2: rank <= 2 (同着対応)
        const top2Set = new Set<number>();
        for (const [k, rnk] of Object.entries(result.rankByUmaban)) {
            if (rnk <= 2) top2Set.add(parseInt(k, 10));
        }
        if (top2Set.size === 0) result.order.slice(0, 2).forEach(u => top2Set.add(u));
        const top3Set = new Set(result.top3);

        const rng = makeRng(opts.seed ^ (parseInt(item.spec.raceId.slice(-6), 10) || 0));

        const base = computeModelV2(race, { weightsOverride: weights });

        let winArr: number[] = [];
        let top2Arr: number[] = [];
        let top3Arr: number[] = [];

        if (opts.useMixture) {
            const pace = base.paceIndex;
            const paceShift = Number(process.env.KEIBA_PACE_SHIFT || '') || 0.6;
            const scale = Number(process.env.KEIBA_PACE_SOFTMAX_SCALE || '') || 1.2;
            const normalBias = Number(process.env.KEIBA_PACE_NORMAL_BIAS || '') || 0.8;
            const w = softmax3(-scale * pace, normalBias, +scale * pace);

            const slow = computeModelV2(race, { weightsOverride: weights, paceOverride: Math.max(-1, pace - paceShift) });
            const fast = computeModelV2(race, { weightsOverride: weights, paceOverride: Math.min(+1, pace + paceShift) });

            const fSlow = estimateFinishProbs(slow.probs, opts.mcIters, rng);
            const fNorm = estimateFinishProbs(base.probs, opts.mcIters, rng);
            const fFast = estimateFinishProbs(fast.probs, opts.mcIters, rng);

            winArr = fSlow.win.map((_, i) => w[0] * fSlow.win[i] + w[1] * fNorm.win[i] + w[2] * fFast.win[i]);
            top2Arr = fSlow.top2.map((_, i) => w[0] * fSlow.top2[i] + w[1] * fNorm.top2[i] + w[2] * fFast.top2[i]);
            top3Arr = fSlow.top3.map((_, i) => w[0] * fSlow.top3[i] + w[1] * fNorm.top3[i] + w[2] * fFast.top3[i]);
        } else {
            const f = estimateFinishProbs(base.probs, opts.mcIters, rng);
            winArr = f.win;
            top2Arr = f.top2;
            top3Arr = f.top3;
        }

        const idx = race.horses.findIndex(h => h.number === winner);
        if (idx < 0) continue;
        const pWin = clamp(winArr[idx], 1e-12, 1);
        ll += -Math.log(pWin);
        nRaces += 1;

        race.horses.forEach((h, i) => {
            const p2 = clamp(top2Arr[i], 0, 1);
            const y2 = top2Set.has(h.number) ? 1 : 0;
            top2P.push(p2);
            top2Y.push(y2);

            const p3 = clamp(top3Arr[i], 0, 1);
            const y3 = top3Set.has(h.number) ? 1 : 0;
            top3P.push(p3);
            top3Y.push(y3);
        });
    }

    if (nRaces === 0) {
        return { obj: Number.POSITIVE_INFINITY, logloss: Number.POSITIVE_INFINITY, brierTop2: 1, eceTop2: 1, brierTop3: 1, eceTop3: 1, nRaces: 0 };
    }

    const logloss = ll / nRaces;
    const brierTop2 = mean(top2P.map((p, i) => (p - top2Y[i]) ** 2));
    const eceTop2 = ece(top2P, top2Y, opts.bins);
    const brierTop3 = mean(top3P.map((p, i) => (p - top3Y[i]) ** 2));
    const eceTop3 = ece(top3P, top3Y, opts.bins);
    const obj =
        logloss +
        opts.lambdaBrierTop2 * brierTop2 +
        opts.lambdaEceTop2 * eceTop2 +
        opts.lambdaBrierTop3 * brierTop3 +
        opts.lambdaEceTop3 * eceTop3;
    return { obj, logloss, brierTop2, eceTop2, brierTop3, eceTop3, nRaces };
}

async function main() {
    const file = arg('--data', path.join('data', 'backtest_train.json'))!;
    const iters = Number(arg('--iters', '120')) || 120;
    const sigma = Number(arg('--sigma', '0.15')) || 0.15;
    const outPath = arg('--out', path.join('data', 'modelWeights.json'))!;

    const mcIters = Number(arg('--mc', process.env.KEIBA_OPT_MC_ITERATIONS || '1500'));
    const bins = Number(arg('--bins', process.env.KEIBA_ECE_BINS || '10'));
    const seed = Number(arg('--seed', process.env.KEIBA_OPT_SEED || '777'));
    const lambdaBrierTop2 = Number(arg('--lambda_top2_brier', process.env.KEIBA_LAMBDA_TOP2_BRIER || '0.4'));
    const lambdaEceTop2 = Number(arg('--lambda_top2_ece', process.env.KEIBA_LAMBDA_TOP2_ECE || '0.8'));
    const lambdaBrierTop3 = Number(arg('--lambda_top3_brier', process.env.KEIBA_LAMBDA_TOP3_BRIER || '0.6'));
    const lambdaEceTop3 = Number(arg('--lambda_top3_ece', process.env.KEIBA_LAMBDA_TOP3_ECE || '1.2'));
    const useMixture = (arg('--mix', process.env.KEIBA_OPT_USE_PACE_MIXTURE || '1') === '1');

    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as RaceSpec[];
    const specs = Array.isArray(raw) ? raw : [];
    if (specs.length === 0) {
        console.log(`No races in ${file}.`);
        process.exit(0);
    }

    console.log(`Preloading races/results... (${specs.length}) cacheDir=${cacheDir()}`);
    const dataset = await preload(specs);
    console.log(`Loaded: ${dataset.length}/${specs.length}`);
    if (dataset.length === 0) process.exit(0);

    const base = getModelWeights();
    let best = base;
    let bestEval = evalObjective(dataset, best, { mcIters, bins, seed, useMixture, lambdaBrierTop2, lambdaEceTop2, lambdaBrierTop3, lambdaEceTop3 });

    console.log(`Start: obj=${bestEval.obj.toFixed(6)} logloss=${bestEval.logloss.toFixed(6)} brierTop2=${bestEval.brierTop2.toFixed(6)} eceTop2=${bestEval.eceTop2.toFixed(6)} brierTop3=${bestEval.brierTop3.toFixed(6)} eceTop3=${bestEval.eceTop3.toFixed(6)} N=${bestEval.nRaces}`);
    console.log(`base=${JSON.stringify(best)}`);

    for (let k = 1; k <= iters; k++) {
        const cand = mutate(best, sigma);
        const ev = evalObjective(dataset, cand, { mcIters, bins, seed, useMixture, lambdaBrierTop2, lambdaEceTop2, lambdaBrierTop3, lambdaEceTop3 });
        if (ev.obj < bestEval.obj) {
            bestEval = ev;
            best = cand;
            console.log(`[BEST] iter=${k} obj=${bestEval.obj.toFixed(6)} logloss=${bestEval.logloss.toFixed(6)} brierTop2=${bestEval.brierTop2.toFixed(6)} eceTop2=${bestEval.eceTop2.toFixed(6)} brierTop3=${bestEval.brierTop3.toFixed(6)} eceTop3=${bestEval.eceTop3.toFixed(6)} w=${JSON.stringify(best)}`);
        } else if (k % 10 === 0) {
            console.log(`[..] iter=${k} curBestObj=${bestEval.obj.toFixed(6)}`);
        }
    }

    saveModelWeightsToFile(best, outPath);
    console.log(`Saved best weights to ${outPath}`);
    console.log(`Best: obj=${bestEval.obj.toFixed(6)} logloss=${bestEval.logloss.toFixed(6)} brierTop2=${bestEval.brierTop2.toFixed(6)} eceTop2=${bestEval.eceTop2.toFixed(6)} brierTop3=${bestEval.brierTop3.toFixed(6)} eceTop3=${bestEval.eceTop3.toFixed(6)} N=${bestEval.nRaces}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
