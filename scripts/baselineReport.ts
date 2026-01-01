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
                cnt++;
                ps += p;
                ys += labels[i];
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

function buildTopKLabels(result: RaceResult): { top2: Set<number>; top3: Set<number> } {
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

type Pred = { win: number[]; top2: number[]; top3: number[]; ok: boolean; note?: string };

function uniformPred(n: number, mc: number, rng: () => number): Pred {
    const w = Array.from({ length: n }, () => 1 / n);
    const f = estimateFinishProbs(w, mc, rng);
    return { win: f.win, top2: f.top2, top3: f.top3, ok: true, note: 'uniform' };
}

function marketPred(race: Race, mc: number, rng: () => number): Pred {
    const odds = race.horses.map(h => h.odds);
    if (!odds.every(o => o != null && o > 0)) return { win: [], top2: [], top3: [], ok: false, note: 'market odds missing' };
    const inv = odds.map(o => 1 / (o as number));
    const s = inv.reduce((a, b) => a + b, 0);
    const w = inv.map(x => x / s);
    const f = estimateFinishProbs(w, mc, rng);
    return { win: f.win, top2: f.top2, top3: f.top3, ok: true, note: 'market' };
}

function modelPred(race: Race, mc: number, rng: () => number, useMix: boolean, weightsOverride?: Partial<ModelWeights>): Pred {
    const base = computeModelV2(race, { weightsOverride });
    if (!useMix) {
        const f = estimateFinishProbs(base.probs, mc, rng);
        return { win: f.win, top2: f.top2, top3: f.top3, ok: true, note: 'model' };
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

    const win = fSlow.win.map((_, i) => w[0] * fSlow.win[i] + w[1] * fNorm.win[i] + w[2] * fFast.win[i]);
    const top2 = fSlow.top2.map((_, i) => w[0] * fSlow.top2[i] + w[1] * fNorm.top2[i] + w[2] * fFast.top2[i]);
    const top3 = fSlow.top3.map((_, i) => w[0] * fSlow.top3[i] + w[1] * fNorm.top3[i] + w[2] * fFast.top3[i]);
    return { win, top2, top3, ok: true, note: 'model+mix' };
}

type Agg = {
    races: number;
    horses: number;
    logloss: number;
    top1: number;
    winInTop3: number;
    pWin: number[]; yWin: number[];
    p2: number[]; y2: number[];
    p3: number[]; y3: number[];
};

function initAgg(): Agg {
    return { races: 0, horses: 0, logloss: 0, top1: 0, winInTop3: 0, pWin: [], yWin: [], p2: [], y2: [], p3: [], y3: [] };
}

function finalize(agg: Agg, bins: number) {
    const ll = agg.races ? agg.logloss / agg.races : 0;
    const brierWin = mean(agg.pWin.map((p, i) => (p - agg.yWin[i]) ** 2));
    const brier2 = mean(agg.p2.map((p, i) => (p - agg.y2[i]) ** 2));
    const brier3 = mean(agg.p3.map((p, i) => (p - agg.y3[i]) ** 2));
    return {
        races: agg.races,
        horses: agg.horses,
        logloss: ll,
        top1Acc: agg.races ? agg.top1 / agg.races : 0,
        winnerInTop3: agg.races ? agg.winInTop3 / agg.races : 0,
        brierWin, eceWin: ece(agg.pWin, agg.yWin, bins),
        brierTop2: brier2, eceTop2: ece(agg.p2, agg.y2, bins),
        brierTop3: brier3, eceTop3: ece(agg.p3, agg.y3, bins),
        avgPWin: mean(agg.pWin), avgYWin: mean(agg.yWin),
        avgP2: mean(agg.p2), avgY2: mean(agg.y2),
        avgP3: mean(agg.p3), avgY3: mean(agg.y3),
    };
}

async function main() {
    const dataFile = arg('--data', path.join('data', 'backtest_holdout.json'))!;
    const outFile = arg('--out', path.join('data', 'baseline_report.json'))!;
    const seed = Number(arg('--seed', '12345')) || 12345;
    const mc = Number(arg('--mc', '4000')) || 4000;
    const bins = Number(arg('--bins', '10')) || 10;
    const useMix = (arg('--mix', '1') !== '0');

    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as RaceSpec[];
    const specs = Array.isArray(raw) ? raw : [];
    if (specs.length === 0) {
        console.log(`No races in ${dataFile}.`);
        process.exit(0);
    }

    console.log(`Loading ${specs.length} races from ${dataFile}...`);

    const baseW = getModelWeights();
    const formOnly: Partial<ModelWeights> = {
        form: baseW.form,
        last3f: 0, dist: 0, going: 0,
        styleScale: 0,
        jockey: 0, trainer: 0,
        insideBiasScale: 0, frontBiasScale: 0, paceScale: 0,
    };
    const noCourse: Partial<ModelWeights> = {
        insideBiasScale: 0, frontBiasScale: 0,
    };

    const models = [
        { id: 'full', kind: 'model' as const, weights: undefined },
        { id: 'formOnly', kind: 'model' as const, weights: formOnly },
        { id: 'noCourse', kind: 'model' as const, weights: noCourse },
        { id: 'uniform', kind: 'uniform' as const, weights: undefined },
        { id: 'market', kind: 'market' as const, weights: undefined },
    ];

    const aggs: Record<string, Agg> = {};
    for (const m of models) aggs[m.id] = initAgg();
    const skipped: Record<string, number> = {};

    for (const s of specs) {
        const loaded = await loadOne(s);
        if (!loaded) continue;
        const { race, result } = loaded;
        const labels = buildTopKLabels(result);
        const winner = result.order[0];
        const nums = race.horses.map(h => h.number);
        const idxWinner = nums.findIndex(n => n === winner);
        if (idxWinner < 0) continue;

        const rng = makeRng(seed ^ (parseInt(s.raceId.slice(-6), 10) || 0));

        for (const m of models) {
            const agg = aggs[m.id];

            let pred: Pred;
            if (m.kind === 'uniform') pred = uniformPred(nums.length, mc, rng);
            else if (m.kind === 'market') pred = marketPred(race, mc, rng);
            else pred = modelPred(race, mc, rng, useMix, m.weights);

            if (!pred.ok) {
                skipped[m.id] = (skipped[m.id] ?? 0) + 1;
                continue;
            }

            // logloss winner
            const pWin = clamp(pred.win[idxWinner], 1e-12, 1);
            agg.logloss += -Math.log(pWin);
            agg.races += 1;

            // top1 & winner in top3 (by win prob)
            const best = nums[pred.win.indexOf(Math.max(...pred.win))];
            if (best === winner) agg.top1 += 1;
            const predTop3 = nums.map((n, i) => ({ n, p: pred.win[i] })).sort((a, b) => b.p - a.p).slice(0, 3).map(x => x.n);
            if (predTop3.includes(winner)) agg.winInTop3 += 1;

            // per-horse labels
            for (let i = 0; i < nums.length; i++) {
                const n = nums[i];
                agg.horses += 1;
                agg.pWin.push(clamp(pred.win[i], 0, 1));
                agg.yWin.push(n === winner ? 1 : 0);
                agg.p2.push(clamp(pred.top2[i], 0, 1));
                agg.y2.push(labels.top2.has(n) ? 1 : 0);
                agg.p3.push(clamp(pred.top3[i], 0, 1));
                agg.y3.push(labels.top3.has(n) ? 1 : 0);
            }
        }
    }

    const report: Record<string, unknown> = {
        config: { dataFile, seed, mc, bins, useMix },
        skipped,
        results: {} as Record<string, unknown>,
    };
    for (const m of models) (report.results as Record<string, unknown>)[m.id] = finalize(aggs[m.id], bins);

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf-8');

    console.log('--- Baseline Report ---');
    for (const m of models) {
        const r = (report.results as Record<string, ReturnType<typeof finalize>>)[m.id];
        console.log(`${m.id}: races=${r.races} logloss=${r.logloss.toFixed(4)} top1=${r.top1Acc.toFixed(3)} brierTop2=${r.brierTop2.toFixed(4)} eceTop3=${r.eceTop3.toFixed(4)}`);
    }
    console.log(`Saved: ${outFile}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
