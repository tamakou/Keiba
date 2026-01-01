import fs from 'fs';
import path from 'path';

import { getRaceDetails } from '../src/lib/netkeiba';
import { computeModelV2 } from '../src/lib/modelV2';
import { estimateFinishProbs } from '../src/lib/simulator';
import { fetchRaceResult, System, RaceResult } from '../src/lib/resultParser';
import { parseRaceCourse, normalizeBaba } from '../src/lib/courseParse';
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

function predictTop2Top3(race: Race, seed: number, mcIters: number, useMix: boolean): { p2: number[]; p3: number[]; note: string } {
    const rng = makeRng(seed ^ (parseInt((race.id || '').slice(-6), 10) || 0));
    const base = computeModelV2(race, {});
    let note = `pace=${base.paceIndex.toFixed(2)}`;

    if (!useMix) {
        const f = estimateFinishProbs(base.probs, mcIters, rng);
        return { p2: f.top2.map(x => clamp(x, 0, 1)), p3: f.top3.map(x => clamp(x, 0, 1)), note };
    }

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

    const p2 = fSlow.top2.map((_, i) => w[0] * fSlow.top2[i] + w[1] * fNorm.top2[i] + w[2] * fFast.top2[i]).map(x => clamp(x, 0, 1));
    const p3 = fSlow.top3.map((_, i) => w[0] * fSlow.top3[i] + w[1] * fNorm.top3[i] + w[2] * fFast.top3[i]).map(x => clamp(x, 0, 1));

    note = `paceMix pSlow=${w[0].toFixed(2)} pN=${w[1].toFixed(2)} pF=${w[2].toFixed(2)} basePace=${pace.toFixed(2)}`;
    return { p2, p3, note };
}

type Bucket = { p2: number[]; y2: number[]; p3: number[]; y3: number[]; races: Set<string> };

function getBucket(map: Map<string, Bucket>, key: string): Bucket {
    const b = map.get(key);
    if (b) return b;
    const nb: Bucket = { p2: [], y2: [], p3: [], y3: [], races: new Set<string>() };
    map.set(key, nb);
    return nb;
}

function summarize(key: string, b: Bucket, bins: number) {
    const n = b.p2.length;
    const brier2 = mean(b.p2.map((p, i) => (p - b.y2[i]) ** 2));
    const brier3 = mean(b.p3.map((p, i) => (p - b.y3[i]) ** 2));
    return {
        key,
        races: b.races.size,
        samples: n,
        avgP2: mean(b.p2),
        avgY2: mean(b.y2),
        avgP3: mean(b.p3),
        avgY3: mean(b.y3),
        ece2: ece(b.p2, b.y2, bins),
        ece3: ece(b.p3, b.y3, bins),
        brier2,
        brier3
    };
}

async function main() {
    const dataFile = arg('--data', path.join('data', 'backtest_holdout.json'))!;
    const outFile = arg('--out', '');
    const bins = Number(arg('--bins', '10')) || 10;
    const mc = Number(arg('--mc', '4000')) || 4000;
    const seed = Number(arg('--seed', '12345')) || 12345;
    const minSamples = Number(arg('--min', '200')) || 200;
    const useMix = (arg('--mix', '1') !== '0');

    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as RaceSpec[];
    const specs = Array.isArray(raw) ? raw : [];
    if (specs.length === 0) {
        console.log(`No races in ${dataFile}.`);
        process.exit(0);
    }

    console.log(`Loading ${specs.length} races from ${dataFile}...`);

    const byCourse = new Map<string, Bucket>();
    const byDistance = new Map<string, Bucket>();
    const byBaba = new Map<string, Bucket>();

    const overall: Bucket = { p2: [], y2: [], p3: [], y3: [], races: new Set<string>() };

    for (const s of specs) {
        const loaded = await loadOne(s);
        if (!loaded) {
            console.log(`[SKIP] ${s.system} ${s.raceId}`);
            continue;
        }
        const { race, result } = loaded;

        const labels = buildTopKLabels(result);
        const pred = predictTop2Top3(race, seed, mc, useMix);

        const cd = parseRaceCourse(race.course);
        const baba = normalizeBaba(race.baba);
        const courseKey = `${s.system}:${race.venue}:${cd.surface}${cd.distance ?? '??'}:${cd.direction}`;
        const distKey = `${s.system}:${cd.surface}${cd.distance ?? '??'}`;
        const babaKey = `${s.system}:${baba}`;

        const bC = getBucket(byCourse, courseKey);
        const bD = getBucket(byDistance, distKey);
        const bB = getBucket(byBaba, babaKey);

        bC.races.add(`${s.system}:${s.raceId}`);
        bD.races.add(`${s.system}:${s.raceId}`);
        bB.races.add(`${s.system}:${s.raceId}`);
        overall.races.add(`${s.system}:${s.raceId}`);

        race.horses.forEach((h, i) => {
            const y2 = labels.top2.has(h.number) ? 1 : 0;
            const y3 = labels.top3.has(h.number) ? 1 : 0;
            const p2 = pred.p2[i] ?? 0;
            const p3 = pred.p3[i] ?? 0;

            bC.p2.push(p2); bC.y2.push(y2); bC.p3.push(p3); bC.y3.push(y3);
            bD.p2.push(p2); bD.y2.push(y2); bD.p3.push(p3); bD.y3.push(y3);
            bB.p2.push(p2); bB.y2.push(y2); bB.p3.push(p3); bB.y3.push(y3);
            overall.p2.push(p2); overall.y2.push(y2); overall.p3.push(p3); overall.y3.push(y3);
        });
    }

    const overallSummary = summarize('overall', overall, bins);

    const makeList = (m: Map<string, Bucket>) =>
        [...m.entries()]
            .map(([k, b]) => summarize(k, b, bins))
            .filter(x => x.samples >= minSamples)
            .sort((a, b) => b.samples - a.samples);

    const report = {
        config: { dataFile, bins, mc, seed, useMix, minSamples },
        overall: overallSummary,
        byCourse: makeList(byCourse),
        byDistance: makeList(byDistance),
        byBaba: makeList(byBaba),
    };

    console.log('--- Calibration Report ---');
    console.log(`Overall: races=${overallSummary.races} samples=${overallSummary.samples}`);
    console.log(`  ECE(top2)=${overallSummary.ece2.toFixed(4)} Brier(top2)=${overallSummary.brier2.toFixed(4)}`);
    console.log(`  ECE(top3)=${overallSummary.ece3.toFixed(4)} Brier(top3)=${overallSummary.brier3.toFixed(4)}`);
    console.log(`  avgP2=${overallSummary.avgP2.toFixed(3)} avgY2=${overallSummary.avgY2.toFixed(3)}`);
    console.log(`  avgP3=${overallSummary.avgP3.toFixed(3)} avgY3=${overallSummary.avgY3.toFixed(3)}`);

    if (outFile && outFile.trim()) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf-8');
        console.log(`Full report saved to: ${outFile}`);
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
