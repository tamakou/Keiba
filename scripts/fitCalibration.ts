import fs from 'fs';
import path from 'path';

import { getRaceDetails } from '../src/lib/netkeiba';
import { computeModelV2 } from '../src/lib/modelV2';
import { estimateFinishProbs } from '../src/lib/simulator';
import { fetchRaceResult, System, RaceResult } from '../src/lib/resultParser';
import { applyTemperature, applyPlatt, Platt } from '../src/lib/calibration';
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

function logit(p: number): number {
    const x = clamp(p, 1e-12, 1 - 1e-12);
    return Math.log(x / (1 - x));
}

function sigmoid(z: number): number {
    if (z >= 0) {
        const e = Math.exp(-z);
        return 1 / (1 + e);
    }
    const e = Math.exp(z);
    return e / (1 + e);
}

function makeRng(seed: number): () => number {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

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

async function loadOne(spec: RaceSpec): Promise<{ race: Race; result: RaceResult } | null> {
    const pr = cachePath('race', spec.system, spec.raceId);
    const ps = cachePath('result', spec.system, spec.raceId);
    let race = readJsonIfExists<Race>(pr);
    let result = readJsonIfExists<RaceResult>(ps);
    if (!race) {
        const r = await getRaceDetails(spec.raceId, spec.system);
        if (!r) return null;
        race = r;
        writeJson(pr, race);
    }
    if (!result) {
        const rr = await fetchRaceResult(spec.raceId, spec.system);
        if (!rr) return null;
        result = rr;
        writeJson(ps, result);
    }
    if (!result.order?.length) return null;
    return { race, result };
}

function buildTopK(result: RaceResult) {
    const top2 = new Set<number>();
    const top3 = new Set<number>();
    for (const [k, rnk] of Object.entries(result.rankByUmaban)) {
        const u = parseInt(k, 10);
        if (!Number.isFinite(u)) continue;
        if (rnk <= 2) top2.add(u);
        if (rnk <= 3) top3.add(u);
    }
    if (top2.size === 0) result.order.slice(0, 2).forEach(u => top2.add(u));
    if (top3.size === 0) result.order.slice(0, 3).forEach(u => top3.add(u));
    return { top2, top3 };
}

function negLogLossWin(win: number[], winnerIdx: number): number {
    const p = clamp(win[winnerIdx], 1e-12, 1);
    return -Math.log(p);
}

function negLogLossBinary(ps: number[], ys: number[]): number {
    let s = 0;
    for (let i = 0; i < ps.length; i++) {
        const p = clamp(ps[i], 1e-12, 1 - 1e-12);
        const y = ys[i];
        s += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    }
    return s / Math.max(1, ps.length);
}

function fitTemperature(winSets: { win: number[]; winnerIdx: number }[]): number {
    // 1D最適化（粗探索→局所）
    let bestT = 1.0, best = Infinity;
    const evalT = (T: number) => {
        let s = 0;
        for (const ex of winSets) {
            const w = applyTemperature(ex.win, T);
            s += negLogLossWin(w, ex.winnerIdx);
        }
        return s / Math.max(1, winSets.length);
    };
    for (const T of [0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5]) {
        const v = evalT(T);
        if (v < best) { best = v; bestT = T; }
    }
    // 局所探索
    let step = 0.2;
    for (let k = 0; k < 25; k++) {
        const cand = [bestT - step, bestT, bestT + step].map(x => clamp(x, 0.05, 6));
        let improved = false;
        for (const T of cand) {
            const v = evalT(T);
            if (v < best) { best = v; bestT = T; improved = true; }
        }
        if (!improved) step *= 0.6;
    }
    return bestT;
}

function fitPlatt(ps: number[], ys: number[]): Platt {
    // 勾配降下（a,b）
    let a = 1.0, b = 0.0;
    const lr = 0.05;
    for (let it = 0; it < 800; it++) {
        let ga = 0, gb = 0;
        for (let i = 0; i < ps.length; i++) {
            const x = logit(ps[i]);
            const z = a * x + b;
            const p = sigmoid(z);
            const y = ys[i];
            // d/dz (logloss) = p - y
            const dz = (p - y);
            ga += dz * x;
            gb += dz;
        }
        ga /= Math.max(1, ps.length);
        gb /= Math.max(1, ps.length);
        a -= lr * ga;
        b -= lr * gb;
        if (it % 200 === 0) {
            // mild clamp
            a = clamp(a, 0.1, 5.0);
            b = clamp(b, -5.0, 5.0);
        }
    }
    return { a, b };
}

async function main() {
    const dataFile = arg('--data', path.join('data', 'backtest_train.json'))!;
    const outFile = arg('--out', path.join('data', 'calibration.json'))!;
    const seed = Number(arg('--seed', '12345')) || 12345;
    const mc = Number(arg('--mc', '4000')) || 4000;

    const specs = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as RaceSpec[];
    if (!Array.isArray(specs) || specs.length === 0) {
        console.log(`No races in ${dataFile}.`);
        process.exit(0);
    }

    console.log(`Fitting calibration on ${specs.length} races...`);

    const rng = makeRng(seed);

    const winSets: { win: number[]; winnerIdx: number }[] = [];
    const p2: number[] = [], y2: number[] = [];
    const p3: number[] = [], y3: number[] = [];

    for (const s of specs) {
        const loaded = await loadOne(s);
        if (!loaded) continue;
        const { race, result } = loaded;

        const base = computeModelV2(race, {});
        const f = estimateFinishProbs(base.probs, mc, rng);
        const nums = race.horses.map(h => h.number);
        const winner = result.order[0];
        const idxW = nums.findIndex(n => n === winner);
        if (idxW < 0) continue;

        // win（温度校正用）
        winSets.push({ win: f.win, winnerIdx: idxW });

        // Top2/Top3（Platt用）
        const labels = buildTopK(result);
        nums.forEach((n, i) => {
            p2.push(f.top2[i]); y2.push(labels.top2.has(n) ? 1 : 0);
            p3.push(f.top3[i]); y3.push(labels.top3.has(n) ? 1 : 0);
        });
    }

    if (winSets.length < 10) {
        console.log(`Too few races for calibration: ${winSets.length}`);
        process.exit(0);
    }

    console.log(`Fitting temperature on ${winSets.length} races...`);
    const T = fitTemperature(winSets);

    console.log(`Fitting Platt for top2 (${p2.length} samples)...`);
    const pl2 = fitPlatt(p2, y2);

    console.log(`Fitting Platt for top3 (${p3.length} samples)...`);
    const pl3 = fitPlatt(p3, y3);

    // sanity (loss before/after)
    const llBefore = winSets.reduce((a, e) => a + negLogLossWin(e.win, e.winnerIdx), 0) / winSets.length;
    const llAfter = winSets.reduce((a, e) => a + negLogLossWin(applyTemperature(e.win, T), e.winnerIdx), 0) / winSets.length;
    const b2Before = negLogLossBinary(p2, y2);
    const b2After = negLogLossBinary(p2.map(p => applyPlatt(p, pl2)), y2);
    const b3Before = negLogLossBinary(p3, y3);
    const b3After = negLogLossBinary(p3.map(p => applyPlatt(p, pl3)), y3);

    const out = {
        version: 1,
        winTemperature: T,
        top2Platt: pl2,
        top3Platt: pl3,
        diagnostics: {
            winLoglossBefore: llBefore, winLoglossAfter: llAfter,
            top2BinLoglossBefore: b2Before, top2BinLoglossAfter: b2After,
            top3BinLoglossBefore: b3Before, top3BinLoglossAfter: b3After
        }
    };

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n', 'utf-8');
    console.log(JSON.stringify(out, null, 2));
    console.log(`Saved: ${outFile}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
