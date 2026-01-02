// scripts/portfolioBacktest.ts
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
    } catch {
        return null;
    }
}
function writeJson(p: string, obj: unknown): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
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

function addAgg(m: Record<string, Agg>, id: string, stake: number, ret: number, hit: boolean) {
    m[id] ||= { races: 0, stake: 0, ret: 0, hit: 0 };
    m[id].races += 1;
    m[id].stake += stake;
    m[id].ret += ret;
    if (hit) m[id].hit += 1;
}

async function loadRace(spec: RaceSpec, cacheOnly: boolean): Promise<Race | null> {
    const p = cachePath('race', spec.system, spec.raceId);
    const cached = readJsonIfExists<Race>(p);
    if (cached) return cached;
    if (cacheOnly) return null;
    const r = await getRaceDetails(spec.raceId, spec.system);
    if (r) writeJson(p, r);
    return r;
}

async function loadResult(spec: RaceSpec, cacheOnly: boolean): Promise<RaceResult | null> {
    const p = cachePath('result', spec.system, spec.raceId);
    const cached = readJsonIfExists<RaceResult>(p);
    if (cached && cached.order?.length) {
        // payouts が無ければ再取得して上書き（このスクリプト導入後の移行用）
        if (cached.payouts && Object.keys(cached.payouts).length > 0) return cached;
    }
    if (cacheOnly) return null;
    const r = await fetchRaceResult(spec.raceId, spec.system);
    if (r) writeJson(p, r);
    return r;
}

async function main() {
    const dataFile = arg('--data', path.join('data', 'backtest_holdout.json'))!;
    const outFile = arg('--out', path.join('data', 'portfolio_report.json'))!;
    const budget = Number(arg('--budget', '20000')) || 20000;
    const maxBets = Number(arg('--maxBets', '7')) || 7;
    const dreamPct = Number(arg('--dreamPct', '0.03')) || 0.03;
    const unit = Number(arg('--unit', '100')) || 100;
    const cacheOnly = process.argv.includes('--cache-only');

    const specs = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as RaceSpec[];
    if (!Array.isArray(specs) || specs.length === 0) {
        console.log(`No races in ${dataFile}.`);
        process.exit(0);
    }

    const agg: Record<string, Agg> = {};
    let skipped = 0;

    for (const s of specs) {
        const race0 = await loadRace(s, cacheOnly);
        const result = await loadResult(s, cacheOnly);
        if (!race0 || !result || !result.order?.length || !result.payouts) { skipped++; continue; }

        // analyzeRace は破壊的なのでコピー
        const race = JSON.parse(JSON.stringify(race0)) as Race;

        await analyzeRace(race, {
            budgetYen: budget,
            maxBets,
            dreamPct,
            minUnitYen: unit,
            enableOptimization: true,
        });

        const portfolios = race.portfolios || [];
        for (const pf of portfolios) {
            let stakeSum = 0;
            let retSum = 0;
            for (const tip of pf.tips) {
                const stake = stakeForTip(tip, budget, unit);
                const pay = payoutPer100(result, tip.type, tip.selection);
                stakeSum += stake;
                if (pay != null && pay > 0) {
                    retSum += pay * (stake / 100);
                }
            }
            addAgg(agg, pf.id, stakeSum, retSum, retSum > 0);
        }
    }

    const report: any = {
        config: { dataFile, budget, maxBets, dreamPct, unit, cacheOnly },
        skipped,
        results: {},
    };

    for (const [id, a] of Object.entries(agg)) {
        const roi = a.stake > 0 ? a.ret / a.stake : 0;
        report.results[id] = {
            races: a.races,
            stake: a.stake,
            ret: a.ret,
            profit: a.ret - a.stake,
            roi,
            hitRate: a.races > 0 ? a.hit / a.races : 0,
        };
    }

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    console.log(JSON.stringify(report, null, 2));
    console.log(`Saved: ${outFile}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
