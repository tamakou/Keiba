import fs from 'fs';
import path from 'path';

import { getRaceDetails } from '../src/lib/netkeiba';
import { computeModelV2 } from '../src/lib/modelV2';
import { estimateFinishProbs } from '../src/lib/simulator';
import { fetchRaceResult, System, RaceResult } from '../src/lib/resultParser';
import { Race } from '../src/lib/types';

type RaceSpec = { raceId: string; system: System };

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

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry<T>(fn: () => Promise<T | null>, retries = 2, delayMs = 500): Promise<T | null> {
    for (let i = 0; i <= retries; i++) {
        try {
            const r = await fn();
            if (r) return r;
        } catch (e) {
            if (i < retries) {
                await delay(delayMs * (i + 1));
            } else {
                throw e;
            }
        }
    }
    return null;
}

let cacheOnlyMode = false;

async function getCachedRace(raceId: string, system: System): Promise<Race | null> {
    const p = cachePath('race', system, raceId);
    const cached = readJsonIfExists<Race>(p);
    if (cached) return cached;
    if (cacheOnlyMode) return null;
    const r = await fetchWithRetry(() => getRaceDetails(raceId, system));
    if (r) writeJson(p, r);
    return r;
}

async function getCachedResult(raceId: string, system: System): Promise<RaceResult | null> {
    const p = cachePath('result', system, raceId);
    const cached = readJsonIfExists<RaceResult>(p);
    if (cached) return cached;
    if (cacheOnlyMode) return null;
    const r = await fetchWithRetry(() => fetchRaceResult(raceId, system));
    if (r) writeJson(p, r);
    return r;
}

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
        if (cnt > 0) e += (cnt / n) * Math.abs(ps / cnt - ys / cnt);
    }
    return e;
}

function clamp01(x: number): number {
    return Math.max(0, Math.min(1, x));
}

async function predictWinTop3(raceId: string, system: System, seed: number, mcIters: number) {
    const race = await getCachedRace(raceId, system);
    if (!race) throw new Error(`Race not found: ${raceId} (${system})`);
    const rng = makeRng(seed ^ (parseInt(raceId.slice(-6), 10) || 0));

    const base = computeModelV2(race, {}); // 外部統計はOFF（負荷対策）
    const useMixture = (process.env.KEIBA_BACKTEST_USE_PACE_MIXTURE ?? '1') === '1';

    let winArr: number[] = [];
    let top2Arr: number[] = [];
    let top3Arr: number[] = [];
    let note = `pace=${base.paceIndex.toFixed(2)}`;

    if (useMixture) {
        const pace = base.paceIndex;
        const paceShift = Number(process.env.KEIBA_PACE_SHIFT || '') || 0.6;
        const scale = Number(process.env.KEIBA_PACE_SOFTMAX_SCALE || '') || 1.2;
        const normalBias = Number(process.env.KEIBA_PACE_NORMAL_BIAS || '') || 0.8;
        const w = softmax3(-scale * pace, normalBias, +scale * pace);

        const slow = computeModelV2(race, { paceOverride: Math.max(-1, pace - paceShift) });
        const fast = computeModelV2(race, { paceOverride: Math.min(+1, pace + paceShift) });

        const fSlow = estimateFinishProbs(slow.probs, mcIters, rng);
        const fNorm = estimateFinishProbs(base.probs, mcIters, rng);
        const fFast = estimateFinishProbs(fast.probs, mcIters, rng);

        winArr = fSlow.win.map((_, i) => w[0] * fSlow.win[i] + w[1] * fNorm.win[i] + w[2] * fFast.win[i]);
        top2Arr = fSlow.top2.map((_, i) => w[0] * fSlow.top2[i] + w[1] * fNorm.top2[i] + w[2] * fFast.top2[i]);
        top3Arr = fSlow.top3.map((_, i) => w[0] * fSlow.top3[i] + w[1] * fNorm.top3[i] + w[2] * fFast.top3[i]);
        note = `paceMix pSlow=${w[0].toFixed(2)} pN=${w[1].toFixed(2)} pF=${w[2].toFixed(2)} basePace=${pace.toFixed(2)}`;
    } else {
        const f = estimateFinishProbs(base.probs, mcIters, rng);
        winArr = f.win;
        top2Arr = f.top2;
        top3Arr = f.top3;
    }

    const nums = race.horses.map(h => h.number);
    return { race, nums, winArr: winArr.map(clamp01), top2Arr: top2Arr.map(clamp01), top3Arr: top3Arr.map(clamp01), note };
}

async function main() {
    const file = arg('--data', path.join('data', 'backtest_races.json'))!;
    const seed = Number(arg('--seed', process.env.KEIBA_BACKTEST_SEED || '12345'));
    const mcIters = Number(arg('--mc', process.env.KEIBA_BACKTEST_MC_ITERATIONS || '8000'));
    const bins = Number(arg('--bins', process.env.KEIBA_ECE_BINS || '10'));
    cacheOnlyMode = process.argv.includes('--cache-only');

    const specs = JSON.parse(fs.readFileSync(file, 'utf-8')) as RaceSpec[];
    if (!Array.isArray(specs) || specs.length === 0) {
        console.log(`No races in ${file}.`);
        process.exit(0);
    }

    let raceN = 0;
    let ll = 0;
    let top1 = 0;
    let winnerInPredTop3 = 0;

    const winP: number[] = [];
    const winY: number[] = [];
    const top2P: number[] = [];
    const top2Y: number[] = [];
    const top3P: number[] = [];
    const top3Y: number[] = [];

    for (const s of specs) {
        try {
            const result = await getCachedResult(s.raceId, s.system);
            if (!result || result.order.length === 0) {
                console.log(`[SKIP] result parse failed ${s.system} ${s.raceId}`);
                continue;
            }
            const winner = result.order[0];
            // Top2: rank <= 2 （同着対応）
            const top2Set = new Set<number>();
            for (const [k, rnk] of Object.entries(result.rankByUmaban)) {
                if (rnk <= 2) top2Set.add(parseInt(k, 10));
            }
            if (top2Set.size === 0) result.order.slice(0, 2).forEach(u => top2Set.add(u));
            const top3Set = new Set(result.top3);

            const pred = await predictWinTop3(s.raceId, s.system, seed, mcIters);
            const idx = pred.nums.findIndex(n => n === winner);
            if (idx < 0) continue;

            const pWin = Math.max(1e-12, Math.min(1, pred.winArr[idx]));
            ll += -Math.log(pWin);
            raceN += 1;

            const best = pred.nums[pred.winArr.indexOf(Math.max(...pred.winArr))];
            if (best === winner) top1 += 1;

            const predTop3 = pred.nums
                .map((n, i) => ({ n, p: pred.winArr[i] }))
                .sort((a, b) => b.p - a.p)
                .slice(0, 3)
                .map(x => x.n);
            if (predTop3.includes(winner)) winnerInPredTop3 += 1;

            // 全馬で校正指標
            pred.nums.forEach((n, i) => {
                winP.push(pred.winArr[i]);
                winY.push(n === winner ? 1 : 0);
                top2P.push(pred.top2Arr[i]);
                top2Y.push(top2Set.has(n) ? 1 : 0);
                top3P.push(pred.top3Arr[i]);
                top3Y.push(top3Set.has(n) ? 1 : 0);
            });

            console.log(`[OK] ${s.system} ${s.raceId} win=${winner} pWin=${pWin.toFixed(4)} predTop3=${predTop3.join(',')} note=${pred.note}`);
        } catch (e) {
            console.log(`[ERROR] ${s.system} ${s.raceId}: ${e}`);
        }
    }

    if (raceN === 0) {
        console.log('No evaluated races.');
        process.exit(0);
    }

    const brierWin = mean(winP.map((p, i) => (p - winY[i]) ** 2));
    const brierTop2 = mean(top2P.map((p, i) => (p - top2Y[i]) ** 2));
    const brierTop3 = mean(top3P.map((p, i) => (p - top3Y[i]) ** 2));
    const eceWin = ece(winP, winY, bins);
    const eceTop2 = ece(top2P, top2Y, bins);
    const eceTop3 = ece(top3P, top3Y, bins);

    console.log('--- Summary ---');
    console.log(`Races=${raceN}  MC=${mcIters}  bins=${bins}`);
    console.log(`LogLoss(win)=${(ll / raceN).toFixed(6)}`);
    console.log(`Brier(win)=${brierWin.toFixed(6)}  ECE(win)=${eceWin.toFixed(6)}`);
    console.log(`Brier(top2)=${brierTop2.toFixed(6)} ECE(top2)=${eceTop2.toFixed(6)}`);
    console.log(`Brier(top3)=${brierTop3.toFixed(6)} ECE(top3)=${eceTop3.toFixed(6)}`);
    console.log(`Top1Acc=${(top1 / raceN).toFixed(3)}`);
    console.log(`WinnerInPredTop3=${(winnerInPredTop3 / raceN).toFixed(3)}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
