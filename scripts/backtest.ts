import fs from 'fs';
import path from 'path';

import { getRaceDetails } from '../src/lib/netkeiba';
import { computeModelV2 } from '../src/lib/modelV2';
import { estimateFinishProbs } from '../src/lib/simulator';
import { fetchRaceResult, System } from '../src/lib/resultParser';

type RaceSpec = { raceId: string; system: System };

function arg(name: string, def?: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return def;
}

function makeRng(seed: number): () => number {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function softmax3(a: number, b: number, c: number): [number, number, number] {
    const ea = Math.exp(a), eb = Math.exp(b), ec = Math.exp(c);
    const s = ea + eb + ec;
    return [ea / s, eb / s, ec / s];
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
            const ap = ps / cnt;
            const ay = ys / cnt;
            e += (cnt / n) * Math.abs(ap - ay);
        }
    }
    return e;
}

function clamp01(x: number): number {
    return Math.max(0, Math.min(1, x));
}

async function predictWinTop3Probs(raceId: string, system: System, rng: () => number, mcIters: number): Promise<{
    win: Map<number, number>;
    top3: Map<number, number>;
    note: string;
}> {
    const race = await getRaceDetails(raceId, system);
    if (!race) throw new Error(`Race not found: ${raceId} (${system})`);

    // 外部統計は backtest ではデフォルトOFF推奨（負荷対策）
    const v2 = computeModelV2(race, {});

    const useMixture = (process.env.KEIBA_BACKTEST_USE_PACE_MIXTURE ?? '1') === '1';
    let note = `pace=${v2.paceIndex.toFixed(2)}`;

    const horseNumbers = race.horses.map(h => h.number);

    const mix = (a: number[], b: number[], c: number[], w: [number, number, number]) =>
        a.map((_, i) => w[0] * a[i] + w[1] * b[i] + w[2] * c[i]);

    let winP: number[] = [];
    let top3P: number[] = [];

    if (useMixture) {
        const pace = v2.paceIndex;
        const paceShift = Number(process.env.KEIBA_PACE_SHIFT || '') || 0.6;
        const scale = Number(process.env.KEIBA_PACE_SOFTMAX_SCALE || '') || 1.2;
        const normalBias = Number(process.env.KEIBA_PACE_NORMAL_BIAS || '') || 0.8;
        const w = softmax3(-scale * pace, normalBias, +scale * pace);

        const slowW = computeModelV2(race, { paceOverride: Math.max(-1, pace - paceShift) });
        const fastW = computeModelV2(race, { paceOverride: Math.min(+1, pace + paceShift) });

        const slowF = estimateFinishProbs(slowW.probs, mcIters, rng);
        const normF = estimateFinishProbs(v2.probs, mcIters, rng);
        const fastF = estimateFinishProbs(fastW.probs, mcIters, rng);

        winP = mix(slowF.win, normF.win, fastF.win, w);
        top3P = mix(slowF.top3, normF.top3, fastF.top3, w);
        note = `paceMix pSlow=${w[0].toFixed(2)} pN=${w[1].toFixed(2)} pF=${w[2].toFixed(2)} basePace=${pace.toFixed(2)}`;
    } else {
        const f = estimateFinishProbs(v2.probs, mcIters, rng);
        winP = f.win;
        top3P = f.top3;
    }

    const win = new Map<number, number>();
    const top3 = new Map<number, number>();
    horseNumbers.forEach((n, i) => {
        win.set(n, clamp01(winP[i]));
        top3.set(n, clamp01(top3P[i]));
    });

    return { win, top3, note };
}

async function main() {
    const file = arg('--data', path.join('data', 'backtest_races.json'))!;
    const json = JSON.parse(fs.readFileSync(file, 'utf-8')) as RaceSpec[];
    if (!Array.isArray(json) || json.length === 0) {
        console.log(`No races in ${file}. Fill it with past race ids first.`);
        process.exit(0);
    }

    const seed = Number(arg('--seed', process.env.KEIBA_BACKTEST_SEED || '12345'));
    const mcIters = Number(arg('--mc', process.env.KEIBA_BACKTEST_MC_ITERATIONS || '8000'));
    const bins = Number(arg('--bins', process.env.KEIBA_ECE_BINS || '10'));

    let raceN = 0;
    let ll = 0;
    let top1 = 0;
    let winnerInPredTop3 = 0;

    // 全馬サンプルで集計（頭数依存を排除）
    const winP: number[] = [];
    const winY: number[] = [];
    const top3P: number[] = [];
    const top3Y: number[] = [];

    for (const r of json) {
        try {
            const result = await fetchRaceResult(r.raceId, r.system);
            if (!result || result.order.length === 0) {
                console.log(`[SKIP] result parse failed ${r.system} ${r.raceId}`);
                continue;
            }
            const winner = result.order[0];
            const top3Set = new Set(result.top3);

            const rng = makeRng(seed ^ (parseInt(r.raceId.slice(-6), 10) || 0));
            const pred = await predictWinTop3Probs(r.raceId, r.system, rng, mcIters);
            const p = pred.win.get(winner) ?? 1e-12;
            const pSafe = Math.max(1e-12, Math.min(1, p));

            ll += -Math.log(pSafe);
            raceN += 1;

            const best = [...pred.win.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            const predTop3 = [...pred.win.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
            if (best === winner) top1 += 1;
            if (predTop3.includes(winner)) winnerInPredTop3 += 1;

            // 全馬サンプル集計（win / top3）
            for (const [num, pw] of pred.win.entries()) {
                winP.push(clamp01(pw));
                winY.push(num === winner ? 1 : 0);

                const pt = pred.top3.get(num) ?? 0;
                top3P.push(clamp01(pt));
                top3Y.push(top3Set.has(num) ? 1 : 0);
            }

            console.log(`[OK] ${r.system} ${r.raceId} win=${winner} pWin=${pSafe.toFixed(4)} predTop3=${predTop3.join(',')} note=${pred.note}`);
        } catch (e) {
            console.log(`[ERROR] ${r.system} ${r.raceId}: ${e}`);
        }
    }

    if (raceN === 0) {
        console.log('No evaluated races.');
        process.exit(0);
    }

    const brierWin = mean(winP.map((p, i) => (p - winY[i]) ** 2));
    const brierTop3 = mean(top3P.map((p, i) => (p - top3Y[i]) ** 2));
    const eceWin = ece(winP, winY, bins);
    const eceTop3 = ece(top3P, top3Y, bins);

    console.log('--- Summary ---');
    console.log(`Races=${raceN}  MC=${mcIters}  bins=${bins}`);
    console.log(`LogLoss(win)=${(ll / raceN).toFixed(6)}`);
    console.log(`Brier(win)=${brierWin.toFixed(6)}  ECE(win)=${eceWin.toFixed(6)}`);
    console.log(`Brier(top3)=${brierTop3.toFixed(6)} ECE(top3)=${eceTop3.toFixed(6)}`);
    console.log(`Top1Acc=${(top1 / raceN).toFixed(3)}`);
    console.log(`WinnerInPredTop3=${(winnerInPredTop3 / raceN).toFixed(3)}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
