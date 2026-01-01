import fs from 'fs';
import path from 'path';

import { getRaceDetails } from '../src/lib/netkeiba';
import { computeModelV2 } from '../src/lib/modelV2';
import { estimateFinishProbs } from '../src/lib/simulator';
import { fetchRaceResult, System, RaceResult } from '../src/lib/resultParser';
import { getModelWeights, ModelWeights } from '../src/lib/modelWeights';
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

function clamp01(x: number): number {
    return clamp(x, 0, 1);
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
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
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
                cnt++; ps += p; ys += labels[i];
            }
        }
        if (cnt > 0) e += (cnt / n) * Math.abs(ps / cnt - ys / cnt);
    }
    return e;
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

type ModelId = 'full' | 'formOnly' | 'noCourse' | 'uniform' | 'market';

function uniformProbs(n: number): number[] {
    return Array.from({ length: n }, () => 1 / n);
}

function marketWeights(race: Race): number[] | null {
    const odds = race.horses.map(h => h.odds);
    if (!odds.every(o => o != null && o > 0)) return null;
    const inv = odds.map(o => 1 / (o as number));
    const s = inv.reduce((a, b) => a + b, 0);
    return inv.map(x => x / s);
}

function modelWeightsOverride(id: ModelId): Partial<ModelWeights> | undefined {
    const base = getModelWeights();
    if (id === 'formOnly') {
        return {
            form: base.form,
            last3f: 0, dist: 0, going: 0,
            styleScale: 0, jockey: 0, trainer: 0,
            insideBiasScale: 0, frontBiasScale: 0, paceScale: 0,
        };
    }
    if (id === 'noCourse') {
        return { insideBiasScale: 0, frontBiasScale: 0 };
    }
    return undefined;
}

function predictTop2Top3FromWinWeights(race: Race, winWeights: number[], seed: number, mc: number): { win: number[]; top2: number[]; top3: number[] } {
    const rng = makeRng(seed ^ (parseInt((race.id || '').slice(-6), 10) || 0));
    const f = estimateFinishProbs(winWeights, mc, rng);
    return { win: f.win.map(clamp01), top2: f.top2.map(clamp01), top3: f.top3.map(clamp01) };
}

function predictModel(race: Race, seed: number, mc: number, useMix: boolean, weightsOverride?: Partial<ModelWeights>) {
    const rng = makeRng(seed ^ (parseInt((race.id || '').slice(-6), 10) || 0));
    const base = computeModelV2(race, { weightsOverride });
    if (!useMix) {
        const f = estimateFinishProbs(base.probs, mc, rng);
        return { win: f.win.map(clamp01), top2: f.top2.map(clamp01), top3: f.top3.map(clamp01) };
    }
    const pace = base.paceIndex;
    const paceShift = Number(process.env.KEIBA_PACE_SHIFT || '') || 0.6;
    const scale = Number(process.env.KEIBA_PACE_SOFTMAX_SCALE || '') || 1.2;
    const normalBias = Number(process.env.KEIBA_PACE_NORMAL_BIAS || '') || 0.8;
    const w = softmax3(-scale * pace, normalBias, +scale * pace);

    const slow = computeModelV2(race, { weightsOverride, paceOverride: Math.max(-1, pace - paceShift) });
    const fast = computeModelV2(race, { weightsOverride, paceOverride: Math.min(+1, pace + paceShift) });

    const fSlow = estimateFinishProbs(slow.probs, mc, rng);
    const fNorm = estimateFinishProbs(base.probs, mc, rng);
    const fFast = estimateFinishProbs(fast.probs, mc, rng);

    const win = fSlow.win.map((_, i) => w[0] * fSlow.win[i] + w[1] * fNorm.win[i] + w[2] * fFast.win[i]).map(clamp01);
    const top2 = fSlow.top2.map((_, i) => w[0] * fSlow.top2[i] + w[1] * fNorm.top2[i] + w[2] * fFast.top2[i]).map(clamp01);
    const top3 = fSlow.top3.map((_, i) => w[0] * fSlow.top3[i] + w[1] * fNorm.top3[i] + w[2] * fFast.top3[i]).map(clamp01);
    return { win, top2, top3 };
}

function predict(race: Race, id: ModelId, seed: number, mc: number, useMix: boolean): { win: number[]; top2: number[]; top3: number[] } | null {
    if (id === 'uniform') {
        return predictTop2Top3FromWinWeights(race, uniformProbs(race.horses.length), seed, mc);
    }
    if (id === 'market') {
        const w = marketWeights(race);
        if (!w) return null;
        return predictTop2Top3FromWinWeights(race, w, seed, mc);
    }
    const wo = modelWeightsOverride(id);
    return predictModel(race, seed, mc, useMix, wo);
}

type RacePoint = {
    loglossA: number; loglossB: number;
    brier2A: number; brier2B: number;
    brier3A: number; brier3B: number;
    p2A: number[]; y2: number[];
    p2B: number[];
    p3A: number[]; y3: number[];
    p3B: number[];
};

function percentile(a: number[], q: number): number {
    const b = a.slice().sort((x, y) => x - y);
    const i = (b.length - 1) * q;
    const lo = Math.floor(i), hi = Math.ceil(i);
    if (lo === hi) return b[lo];
    const t = i - lo;
    return b[lo] * (1 - t) + b[hi] * t;
}

async function main() {
    const dataFile = arg('--data', path.join('data', 'backtest_holdout.json'))!;
    const outFile = arg('--out', path.join('data', 'significance_report.json'))!;
    const iters = Number(arg('--iters', '500')) || 500;
    const seed = Number(arg('--seed', '12345')) || 12345;
    const mc = Number(arg('--mc', '4000')) || 4000;
    const bins = Number(arg('--bins', '10')) || 10;
    const useMix = (arg('--mix', '1') !== '0');

    const A = (arg('--A', 'full') as ModelId);
    const B = (arg('--B', 'formOnly') as ModelId);

    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as RaceSpec[];
    const specs = Array.isArray(raw) ? raw : [];
    if (specs.length === 0) {
        console.log(`No races in ${dataFile}.`);
        process.exit(0);
    }

    console.log(`Loading ${specs.length} races from ${dataFile}...`);
    console.log(`Comparing ${A} vs ${B}`);

    // build dataset points
    const points: RacePoint[] = [];
    for (const s of specs) {
        const loaded = await loadOne(s);
        if (!loaded) continue;
        const { race, result } = loaded;

        const predA = predict(race, A, seed, mc, useMix);
        const predB = predict(race, B, seed, mc, useMix);
        if (!predA || !predB) continue;

        const winner = result.order[0];
        const nums = race.horses.map(h => h.number);
        const idxW = nums.findIndex(n => n === winner);
        if (idxW < 0) continue;

        const labels = buildTopK(result);

        // logloss
        const pWA = clamp(predA.win[idxW], 1e-12, 1);
        const pWB = clamp(predB.win[idxW], 1e-12, 1);
        const loglossA = -Math.log(pWA);
        const loglossB = -Math.log(pWB);

        // per-race brier (mean over horses)
        const y2 = nums.map(n => labels.top2.has(n) ? 1 : 0);
        const y3 = nums.map(n => labels.top3.has(n) ? 1 : 0);

        const brier2A = mean(predA.top2.map((p, i) => (p - y2[i]) ** 2));
        const brier2B = mean(predB.top2.map((p, i) => (p - y2[i]) ** 2));
        const brier3A = mean(predA.top3.map((p, i) => (p - y3[i]) ** 2));
        const brier3B = mean(predB.top3.map((p, i) => (p - y3[i]) ** 2));

        points.push({
            loglossA, loglossB,
            brier2A, brier2B,
            brier3A, brier3B,
            p2A: predA.top2, p2B: predB.top2, y2,
            p3A: predA.top3, p3B: predB.top3, y3,
        });
    }

    if (points.length < 10) {
        console.log(`Too few comparable races: ${points.length}.`);
        process.exit(0);
    }

    console.log(`Bootstrapping with ${iters} iterations on ${points.length} races...`);

    // bootstrap
    const rng = makeRng(seed);
    const deltasLL: number[] = [];
    const deltasB2: number[] = [];
    const deltasB3: number[] = [];
    const deltasE2: number[] = [];
    const deltasE3: number[] = [];

    for (let t = 0; t < iters; t++) {
        const idxs = Array.from({ length: points.length }, () => Math.floor(rng() * points.length));

        // aggregate
        let llA = 0, llB = 0;
        let b2A = 0, b2B = 0;
        let b3A = 0, b3B = 0;
        const p2A: number[] = [], p2B: number[] = [], y2: number[] = [];
        const p3A: number[] = [], p3B: number[] = [], y3: number[] = [];

        for (const i of idxs) {
            const p = points[i];
            llA += p.loglossA; llB += p.loglossB;
            b2A += p.brier2A; b2B += p.brier2B;
            b3A += p.brier3A; b3B += p.brier3B;
            p2A.push(...p.p2A); p2B.push(...p.p2B); y2.push(...p.y2);
            p3A.push(...p.p3A); p3B.push(...p.p3B); y3.push(...p.y3);
        }

        const n = idxs.length;
        const mllA = llA / n, mllB = llB / n;
        const mb2A = b2A / n, mb2B = b2B / n;
        const mb3A = b3A / n, mb3B = b3B / n;
        const me2A = ece(p2A, y2, bins), me2B = ece(p2B, y2, bins);
        const me3A = ece(p3A, y3, bins), me3B = ece(p3B, y3, bins);

        // delta = B - A （小さい方が良いので delta>0 ならA優位）
        deltasLL.push(mllB - mllA);
        deltasB2.push(mb2B - mb2A);
        deltasB3.push(mb3B - mb3A);
        deltasE2.push(me2B - me2A);
        deltasE3.push(me3B - me3A);
    }

    const summarize = (arr: number[]) => {
        const ci = [percentile(arr, 0.025), percentile(arr, 0.975)];
        const pBetter = arr.filter(x => x > 0).length / arr.length; // AがBより良い確率
        return { mean: mean(arr), ci95: ci, pA_better: pBetter };
    };

    const report = {
        config: { dataFile, A, B, iters, seed, mc, bins, useMix, comparableRaces: points.length },
        delta: {
            logloss: summarize(deltasLL),
            brierTop2: summarize(deltasB2),
            brierTop3: summarize(deltasB3),
            eceTop2: summarize(deltasE2),
            eceTop3: summarize(deltasE3),
        }
    };

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf-8');

    console.log('--- Significance Report ---');
    console.log(`${A} vs ${B} (delta = B - A, positive means ${A} is better)`);
    for (const [k, v] of Object.entries(report.delta)) {
        const s = v as { mean: number; ci95: number[]; pA_better: number };
        console.log(`  ${k}: mean=${s.mean.toFixed(4)} 95%CI=[${s.ci95[0].toFixed(4)}, ${s.ci95[1].toFixed(4)}] P(${A} better)=${s.pA_better.toFixed(3)}`);
    }
    console.log(`Saved: ${outFile}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
