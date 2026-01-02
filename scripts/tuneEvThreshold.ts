// scripts/tuneEvThreshold.ts
import fs from 'fs';
import path from 'path';

import { getRaceDetails } from '../src/lib/netkeiba';
import { analyzeRace } from '../src/lib/analysis';
import { fetchRaceResult, System, RaceResult } from '../src/lib/resultParser';
import { Race, BetType, BettingTip } from '../src/lib/types';

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

type Agg = { races: number; stake: number; ret: number; hit: number };
function initAgg(): Agg { return { races: 0, stake: 0, ret: 0, hit: 0 }; }

async function evalSpecs(specs: RaceSpec[], cfg: {
    budget: number; maxBets: number; dreamPct: number; unit: number; cacheOnly: boolean;
}): Promise<{ byPf: Record<string, Agg>; used: number; skipped: number }> {
    const byPf: Record<string, Agg> = { conservative: initAgg(), balanced: initAgg(), dream: initAgg() };
    let used = 0, skipped = 0;

    for (const s of specs) {
        const loaded = await loadOne(s, cfg.cacheOnly);
        if (!loaded) { skipped++; continue; }
        used++;

        const race0 = loaded.race;
        const result = loaded.result;

        const race = JSON.parse(JSON.stringify(race0)) as Race;

        await analyzeRace(race, {
            budgetYen: cfg.budget,
            maxBets: cfg.maxBets,
            dreamPct: cfg.dreamPct,
            minUnitYen: cfg.unit,
            enableOptimization: true,
        });

        const portfolios = race.portfolios || [];
        for (const pf of portfolios) {
            const a = byPf[pf.id] ?? (byPf[pf.id] = initAgg());
            let stakeSum = 0, retSum = 0;

            for (const tip of pf.tips) {
                const stake = stakeForTip(tip, cfg.budget, cfg.unit);
                const pay = payoutPer100(result, tip.type, tip.selection);
                stakeSum += stake;
                if (pay != null && pay > 0) retSum += pay * (stake / 100);
            }
            a.races += 1;
            a.stake += stakeSum;
            a.ret += retSum;
            if (retSum > 0) a.hit += 1;
        }
    }
    return { byPf, used, skipped };
}

function summary(a: Agg) {
    const roi = a.stake > 0 ? a.ret / a.stake : 0;
    const hitRate = a.races > 0 ? a.hit / a.races : 0;
    return { races: a.races, stake: a.stake, ret: a.ret, profit: a.ret - a.stake, roi, hitRate };
}

async function main() {
    // defaults
    const trainFile = arg('--train', path.join('data', 'backtest_train.json'))!;
    const holdoutFile = arg('--holdout', path.join('data', 'backtest_holdout.json'))!;
    const outFile = arg('--out', path.join('data', 'ev_thresholds.json'))!;
    const budget = Number(arg('--budget', '20000')) || 20000;
    const maxBets = Number(arg('--maxBets', '7')) || 7;
    const dreamPct = Number(arg('--dreamPct', '0.03')) || 0.03;
    const unit = Number(arg('--unit', '100')) || 100;
    const mc = Number(arg('--mc', '2000')) || 2000;
    const cacheOnly = process.argv.includes('--cache-only');

    // tuningは軽めMCでOK（最終評価は別途大きくして回す）
    process.env.KEIBA_MC_ITERATIONS = String(mc);
    process.env.KEIBA_RNG_MODE = 'deterministic';

    const train = JSON.parse(fs.readFileSync(trainFile, 'utf-8')) as RaceSpec[];
    const holdout = JSON.parse(fs.readFileSync(holdoutFile, 'utf-8')) as RaceSpec[];
    if (!Array.isArray(train) || train.length === 0) throw new Error(`No train races: ${trainFile}`);
    if (!Array.isArray(holdout) || holdout.length === 0) throw new Error(`No holdout races: ${holdoutFile}`);

    // 候補（必要なら増やしてOK）
    const cVals = [-0.08, -0.06, -0.05, -0.04, -0.03, -0.02, -0.01, 0];
    const bVals = [-0.01, 0, 0.01, 0.02, 0.03];
    const dVals = [0, 0.01, 0.02, 0.03, 0.05];
    const sVals = [-0.10, -0.08, -0.06, -0.05, -0.04];

    // 初期値
    let bestC = Number(process.env.KEIBA_MIN_EV_CONSERVATIVE ?? '-0.03');
    let bestB = Number(process.env.KEIBA_MIN_EV_BALANCED ?? '0.00');
    let bestD = Number(process.env.KEIBA_MIN_EV_DREAM ?? '0.00');
    let bestS = Number(process.env.KEIBA_SURVIVAL_MAX_NEG ?? '-0.06');

    // ① conservative と survival を同時にチューニング
    let bestScore = -Infinity;
    let bestTrain: any = null;

    console.log('Phase 1: Tuning conservative + survival...');
    for (const c of cVals) {
        for (const s of sVals) {
            process.env.KEIBA_MIN_EV_CONSERVATIVE = String(c);
            process.env.KEIBA_SURVIVAL_MAX_NEG = String(s);

            // balanced/dream は現状値
            process.env.KEIBA_MIN_EV_BALANCED = String(bestB);
            process.env.KEIBA_MIN_EV_DREAM = String(bestD);

            const r = await evalSpecs(train, { budget, maxBets, dreamPct, unit, cacheOnly });
            const sc = summary(r.byPf.conservative);

            // 目的：ROI最大 + 低すぎる的中率を避ける（罰則）
            const penalty = sc.hitRate < 0.20 ? (0.20 - sc.hitRate) * 0.5 : 0; // 調整可
            const score = sc.roi - penalty;

            if (score > bestScore) {
                bestScore = score;
                bestC = c; bestS = s;
                bestTrain = { used: r.used, skipped: r.skipped, conservative: sc, balanced: summary(r.byPf.balanced), dream: summary(r.byPf.dream) };
                console.log(`  New best: c=${c}, s=${s}, ROI=${sc.roi.toFixed(3)}, hitRate=${sc.hitRate.toFixed(3)}`);
            }
        }
    }

    // ② balanced をチューニング（survivalはbestSを固定）
    console.log('Phase 2: Tuning balanced...');
    let bestScoreB = -Infinity;
    for (const b of bVals) {
        process.env.KEIBA_MIN_EV_CONSERVATIVE = String(bestC);
        process.env.KEIBA_SURVIVAL_MAX_NEG = String(bestS);
        process.env.KEIBA_MIN_EV_BALANCED = String(b);
        process.env.KEIBA_MIN_EV_DREAM = String(bestD);

        const r = await evalSpecs(train, { budget, maxBets, dreamPct, unit, cacheOnly });
        const sb = summary(r.byPf.balanced);
        const penalty = sb.hitRate < 0.12 ? (0.12 - sb.hitRate) * 0.7 : 0;
        const score = sb.roi - penalty;

        if (score > bestScoreB) { bestScoreB = score; bestB = b; }
    }

    // ③ dream をチューニング
    console.log('Phase 3: Tuning dream...');
    let bestScoreD = -Infinity;
    for (const d of dVals) {
        process.env.KEIBA_MIN_EV_CONSERVATIVE = String(bestC);
        process.env.KEIBA_SURVIVAL_MAX_NEG = String(bestS);
        process.env.KEIBA_MIN_EV_BALANCED = String(bestB);
        process.env.KEIBA_MIN_EV_DREAM = String(d);

        const r = await evalSpecs(train, { budget, maxBets, dreamPct, unit, cacheOnly });
        const sd = summary(r.byPf.dream);
        // dreamは的中率より"期待値"優先（罰則弱め）
        const penalty = sd.hitRate < 0.05 ? (0.05 - sd.hitRate) * 0.3 : 0;
        const score = sd.roi - penalty;

        if (score > bestScoreD) { bestScoreD = score; bestD = d; }
    }

    // 最終：train/holdout評価
    console.log('Phase 4: Final evaluation...');
    process.env.KEIBA_MIN_EV_CONSERVATIVE = String(bestC);
    process.env.KEIBA_SURVIVAL_MAX_NEG = String(bestS);
    process.env.KEIBA_MIN_EV_BALANCED = String(bestB);
    process.env.KEIBA_MIN_EV_DREAM = String(bestD);

    const trainEval = await evalSpecs(train, { budget, maxBets, dreamPct, unit, cacheOnly });
    const holdEval = await evalSpecs(holdout, { budget, maxBets, dreamPct, unit, cacheOnly });

    const out = {
        version: 1,
        mcIterationsForTuning: mc,
        recommendedEnv: {
            KEIBA_MIN_EV_CONSERVATIVE: bestC,
            KEIBA_MIN_EV_BALANCED: bestB,
            KEIBA_MIN_EV_DREAM: bestD,
            KEIBA_SURVIVAL_MAX_NEG: bestS,
        },
        train: {
            used: trainEval.used, skipped: trainEval.skipped,
            conservative: summary(trainEval.byPf.conservative),
            balanced: summary(trainEval.byPf.balanced),
            dream: summary(trainEval.byPf.dream),
        },
        holdout: {
            used: holdEval.used, skipped: holdEval.skipped,
            conservative: summary(holdEval.byPf.conservative),
            balanced: summary(holdEval.byPf.balanced),
            dream: summary(holdEval.byPf.dream),
        },
        coarseBestDuringConservativeSearch: bestTrain,
    };

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n', 'utf-8');
    console.log(JSON.stringify(out, null, 2));
    console.log(`Saved: ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
