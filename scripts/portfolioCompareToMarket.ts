// scripts/portfolioCompareToMarket.ts
import fs from 'fs';
import path from 'path';

import { getRaceDetails } from '../src/lib/netkeiba';
import { analyzeRace } from '../src/lib/analysis';
import { fetchRaceResult, System, RaceResult } from '../src/lib/resultParser';
import { estimateFinishProbs, estimateBetEventProbs, FinishProbs, BetEventProbs } from '../src/lib/simulator';
import { buildOptimizedPortfolios, OptimizeSettings } from '../src/lib/optimizer';
import { Race, BetType, BettingTip, BettingPortfolio } from '../src/lib/types';

type RaceSpec = { raceId: string; system: System };

function arg(name: string, def?: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return def;
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
    } catch { return null; }
}
function writeJson(p: string, obj: unknown): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function loadOne(spec: RaceSpec, cacheOnly: boolean): Promise<{ race: Race; result: RaceResult } | null> {
    const pr = cachePath('race', spec.system, spec.raceId);
    const ps = cachePath('result', spec.system, spec.raceId);

    let race = readJsonIfExists<Race>(pr);
    let result = readJsonIfExists<RaceResult>(ps);

    if (cacheOnly) {
        if (!race || !result) return null;
        if (!result.order?.length || !result.payouts) return null;
        return { race, result };
    }

    if (!race) {
        const r = await getRaceDetails(spec.raceId, spec.system);
        if (!r) return null;
        race = r; writeJson(pr, race);
    }
    if (!result) {
        const rr = await fetchRaceResult(spec.raceId, spec.system);
        if (!rr || !rr.order?.length || !rr.payouts) return null;
        result = rr; writeJson(ps, result);
    }
    if (!result.order?.length || !result.payouts) return null;
    return { race, result };
}

function topKForPlace(n: number): number {
    if (n <= 4) return 1;
    if (n <= 7) return 2;
    return 3;
}

function hash32(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
function makeRng(seed: number): () => number {
    let x = (seed >>> 0) || 1;
    return () => {
        x = (Math.imul(1664525, x) + 1013904223) >>> 0;
        return x / 4294967296;
    };
}

function keyFor(type: BetType, selection: number[]): string {
    if (type === '単勝' || type === '複勝') return String(selection[0]);
    if (type === '馬単') return `${selection[0]}>${selection[1]}`;
    if (type === '三連単') return `${selection[0]}>${selection[1]}>${selection[2]}`;
    if (selection.length === 2) {
        const a = Math.min(selection[0], selection[1]);
        const b = Math.max(selection[0], selection[1]);
        return `${a}-${b}`;
    }
    if (selection.length === 3) {
        const s = [...selection].sort((x, y) => x - y);
        return `${s[0]}-${s[1]}-${s[2]}`;
    }
    return selection.join('-');
}

function stakeForTip(tip: BettingTip, budget: number, unit: number): number {
    if (tip.stakeYen != null && tip.stakeYen > 0) return Math.floor(tip.stakeYen / unit) * unit;
    if (tip.alloc != null && tip.alloc > 0) {
        const s = Math.floor((budget * (tip.alloc / 100)) / unit) * unit;
        return Math.max(unit, s);
    }
    return unit;
}

function payoutPer100(result: RaceResult, type: BetType, selection: number[]): number | null {
    const p = result.payouts?.[type];
    if (!p) return null;
    const key = keyFor(type, selection);
    const hit = p.find(x => x.key === key);
    return hit ? hit.payoutYen : 0;
}

function evalPortfolio(pf: BettingPortfolio, result: RaceResult, budget: number, unit: number): { stake: number; ret: number; profit: number } {
    let stake = 0, ret = 0;
    for (const tip of pf.tips) {
        const s = stakeForTip(tip, budget, unit);
        const pay = payoutPer100(result, tip.type, tip.selection);
        stake += s;
        if (pay != null && pay > 0) ret += pay * (s / 100);
    }
    return { stake, ret, profit: ret - stake };
}

function marketWeights(race: Race): number[] | null {
    const odds = race.horses.map(h => h.odds);
    if (!odds.every(o => o != null && o > 0)) return null;
    const inv = odds.map(o => 1 / (o as number));
    const s = inv.reduce((a, b) => a + b, 0);
    return inv.map(x => x / s);
}

function buildMarketPortfolios(race0: Race, settings: OptimizeSettings, mc: number): BettingPortfolio[] | null {
    const w = marketWeights(race0);
    if (!w) return null;

    const race = JSON.parse(JSON.stringify(race0)) as Race;
    const seed = hash32(race.id || '') ^ 0xA5A5A5A5;
    const rng = makeRng(seed);

    const kPlace = topKForPlace(race.horses.length);
    const nums = race.horses.map(h => h.number);

    const probs: FinishProbs = estimateFinishProbs(w, mc, rng);
    const events: BetEventProbs = estimateBetEventProbs(w, mc, kPlace, nums, rng);

    // optimizerが参照するフィールドを埋める
    race.horses.forEach((h, i) => {
        h.estimatedProb = probs.win[i];
        h.modelTop2Prob = probs.top2[i];
        h.modelTop3Prob = probs.top3[i];
        h.ev = (h.odds != null && h.odds > 0) ? (h.estimatedProb * h.odds - 1) : null;
        h.factors = ['市場オッズのみ'];
    });

    const opt = buildOptimizedPortfolios({
        race,
        modelWin: probs.win,
        modelProbs: probs,
        betEvents: events,
        kPlace,
        settings,
    });

    if (opt.portfolios.length > 0) return opt.portfolios;

    // 最悪のfallback（オッズテーブル不足など）
    const favIdx = probs.win.indexOf(Math.max(...probs.win));
    const favNo = race.horses[favIdx]?.number;
    if (!favNo) return null;

    return [{
        id: 'conservative',
        name: '市場: 本命単勝',
        description: '市場オッズのみ（fallback）',
        tips: [{ type: '単勝', selection: [favNo], alloc: 100, confidence: 0.6, reason: '市場本命', stakeYen: settings.budgetYen }],
        riskLevel: 'Low',
    }];
}

function percentile(a: number[], q: number): number {
    const b = a.slice().sort((x, y) => x - y);
    const i = (b.length - 1) * q;
    const lo = Math.floor(i), hi = Math.ceil(i);
    if (lo === hi) return b[lo];
    const t = i - lo;
    return b[lo] * (1 - t) + b[hi] * t;
}

function erf(x: number): number {
    // Abramowitz-Stegun
    const sign = x >= 0 ? 1 : -1;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
    return sign * y;
}

function binomPValueTwoSided(k: number, n: number): number {
    // 簡易：両側= 2*min(P(X<=k),P(X>=k))
    // nが大きいと重いので正規近似（十分）
    const p = 0.5;
    const mu = n * p;
    const sigma = Math.sqrt(n * p * (1 - p));
    const z = (k - mu) / (sigma || 1);
    const phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
    const cdf = phi(z);
    const tail = Math.min(cdf, 1 - cdf);
    return Math.min(1, 2 * tail);
}

async function main() {
    const dataFile = arg('--data', path.join('data', 'backtest_holdout.json'))!;
    const outFile = arg('--out', path.join('data', 'portfolio_vs_market.json'))!;
    const budget = Number(arg('--budget', '20000')) || 20000;
    const maxBets = Number(arg('--maxBets', '7')) || 7;
    const dreamPct = Number(arg('--dreamPct', '0.03')) || 0.03;
    const unit = Number(arg('--unit', '100')) || 100;
    const mc = Number(arg('--mc', process.env.KEIBA_MC_ITERATIONS || '4000')) || 4000;
    const iters = Number(arg('--iters', '2000')) || 2000;
    const seed = Number(arg('--seed', '12345')) || 12345;
    const cacheOnly = process.argv.includes('--cache-only');

    process.env.KEIBA_MC_ITERATIONS = String(mc);
    process.env.KEIBA_RNG_MODE = 'deterministic';

    const specs = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as RaceSpec[];
    if (!Array.isArray(specs) || specs.length === 0) throw new Error(`No races: ${dataFile}`);

    const settings: OptimizeSettings = { budgetYen: budget, maxBets, dreamPct, minUnitYen: unit };

    const diffs: Record<string, number[]> = { conservative: [], balanced: [], dream: [] };
    const perRace: any[] = [];

    console.log(`Comparing model vs market on ${specs.length} races...`);

    for (const s of specs) {
        const loaded = await loadOne(s, cacheOnly);
        if (!loaded) continue;
        const { race: race0, result } = loaded;

        // A: model
        const raceA = JSON.parse(JSON.stringify(race0)) as Race;
        await analyzeRace(raceA, { budgetYen: budget, maxBets, dreamPct, minUnitYen: unit, enableOptimization: true });
        const pfA = new Map((raceA.portfolios || []).map(p => [p.id, p]));

        // B: market
        const marketPortfolios = buildMarketPortfolios(race0, settings, mc);
        if (!marketPortfolios) continue;
        const pfB = new Map(marketPortfolios.map(p => [p.id, p]));

        const row: any = { raceId: s.raceId, system: s.system };

        for (const id of ['conservative', 'balanced', 'dream']) {
            const a = pfA.get(id);
            const b = pfB.get(id);
            if (!a || !b) continue;
            const ea = evalPortfolio(a, result, budget, unit);
            const eb = evalPortfolio(b, result, budget, unit);
            const diff = ea.profit - eb.profit;
            diffs[id].push(diff);
            row[id] = { model: ea, market: eb, diff };
        }
        perRace.push(row);
    }

    const rng = makeRng(seed);
    const report: any = {
        config: { dataFile, budget, maxBets, dreamPct, unit, mc, iters },
        n: { conservative: diffs.conservative.length, balanced: diffs.balanced.length, dream: diffs.dream.length },
        results: {},
    };

    for (const id of ['conservative', 'balanced', 'dream']) {
        const d = diffs[id];
        if (d.length < 20) {
            console.log(`  ${id}: insufficient data (n=${d.length})`);
            continue;
        }

        const mean = d.reduce((a, b) => a + b, 0) / d.length;
        const wins = d.filter(x => x > 0).length;
        const pSign = binomPValueTwoSided(wins, d.length);

        // paired bootstrap (mean diff)
        const boots: number[] = [];
        for (let t = 0; t < iters; t++) {
            let s = 0;
            for (let i = 0; i < d.length; i++) s += d[Math.floor(rng() * d.length)];
            boots.push(s / d.length);
        }
        const lo = percentile(boots, 0.025);
        const hi = percentile(boots, 0.975);
        const pOneSided = boots.filter(x => x <= 0).length / boots.length;

        report.results[id] = {
            meanProfitDiffYen: mean,
            ci95: [lo, hi],
            p_bootstrap_one_sided_mean_le_0: pOneSided,
            signTest: { wins, n: d.length, p_two_sided: pSign },
        };

        console.log(`  ${id}: meanDiff=¥${mean.toFixed(0)}, 95%CI=[${lo.toFixed(0)}, ${hi.toFixed(0)}], p=${pOneSided.toFixed(3)}`);
    }

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    console.log(`Saved: ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
