/**
 * preloadCache.ts
 * 
 * 既存のバックテストレースリストからレース詳細と結果をキャッシュにプリロードします。
 * 
 * 使い方:
 * npx tsx scripts/preloadCache.ts --data data/backtest_races.json
 */
import fs from 'fs';
import path from 'path';

import { getRaceDetails } from '../src/lib/netkeiba';
import { fetchRaceResult, System, RaceResult } from '../src/lib/resultParser';
import { Race } from '../src/lib/types';

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

function readJsonIfExists<T>(fp: string): T | null {
    try {
        if (!fs.existsSync(fp)) return null;
        return JSON.parse(fs.readFileSync(fp, 'utf-8')) as T;
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

async function main() {
    const dataFile = arg('--data', path.join('data', 'backtest_races.json'))!;
    const delayMs = Number(arg('--delay', '200')) || 200;

    const specs = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as RaceSpec[];
    if (!Array.isArray(specs) || specs.length === 0) {
        console.log(`No races in ${dataFile}.`);
        process.exit(0);
    }

    console.log(`Preloading cache for ${specs.length} races...`);

    let cached = 0;
    let fetched = 0;
    let errors = 0;

    for (const s of specs) {
        const rp = cachePath('race', s.system, s.raceId);
        const sp = cachePath('result', s.system, s.raceId);

        // Check if both are already cached
        const hasRace = readJsonIfExists<Race>(rp) !== null;
        const hasResult = readJsonIfExists<RaceResult>(sp) !== null;

        if (hasRace && hasResult) {
            cached++;
            continue;
        }

        try {
            if (!hasResult) {
                const result = await fetchRaceResult(s.raceId, s.system);
                if (result) {
                    writeJson(sp, result);
                    fetched++;
                } else {
                    errors++;
                    console.log(`[ERROR] No result: ${s.system} ${s.raceId}`);
                    continue;
                }
            }

            if (!hasRace) {
                await delay(delayMs); // Rate limiting
                const race = await getRaceDetails(s.raceId, s.system);
                if (race) {
                    writeJson(rp, race);
                    fetched++;
                } else {
                    errors++;
                    console.log(`[ERROR] No race: ${s.system} ${s.raceId}`);
                }
            }

            if ((cached + fetched) % 50 === 0) {
                console.log(`Progress: cached=${cached} fetched=${fetched} errors=${errors}`);
            }
        } catch (e) {
            errors++;
            console.log(`[ERROR] ${s.system} ${s.raceId}: ${e}`);
        }
    }

    console.log('--- Preload Done ---');
    console.log(`Total: ${specs.length} | Already cached: ${cached} | Fetched: ${fetched} | Errors: ${errors}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
