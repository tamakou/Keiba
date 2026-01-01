import fs from 'fs';
import path from 'path';
import { getRaceDetails } from '../src/lib/netkeiba';
import { parseRaceCourse, normalizeBaba } from '../src/lib/courseParse';

type System = 'JRA' | 'NAR';
type RaceSpec = { raceId: string; system: System };

function arg(name: string, def?: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return def;
}

function inc(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function topN(map: Map<string, number>, n = 20): [string, number][] {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

async function main() {
    const file = arg('--data', path.join('data', 'backtest_races.json'))!;
    const out = arg('--out', '');
    const json = JSON.parse(fs.readFileSync(file, 'utf-8')) as RaceSpec[];
    if (!Array.isArray(json) || json.length === 0) {
        console.log(`No races in ${file}.`);
        process.exit(0);
    }

    const bySystem = new Map<string, number>();
    const byVenue = new Map<string, number>();
    const bySurfaceDist = new Map<string, number>();
    const byBaba = new Map<string, number>();

    for (const r of json) {
        try {
            const race = await getRaceDetails(r.raceId, r.system);
            if (!race) continue;
            inc(bySystem, r.system);
            inc(byVenue, `${r.system}:${race.venue}`);

            const cd = parseRaceCourse(race.course);
            const keySD = `${r.system}:${cd.surface}${cd.distance ?? '??'}:${cd.direction}`;
            inc(bySurfaceDist, keySD);

            const b = normalizeBaba(race.baba);
            inc(byBaba, `${r.system}:${b}`);
        } catch (e) {
            console.log(`[ERROR] ${r.system} ${r.raceId}: ${e}`);
        }
    }

    console.log('--- Dataset Audit ---');
    console.log('System:', topN(bySystem, 10));
    console.log('Venue top:', topN(byVenue, 20));
    console.log('Surface/Dist top:', topN(bySurfaceDist, 20));
    console.log('Baba top:', topN(byBaba, 10));

    if (out && out.trim().length > 0) {
        const obj = {
            system: Object.fromEntries(bySystem),
            venue: Object.fromEntries(byVenue),
            surfaceDist: Object.fromEntries(bySurfaceDist),
            baba: Object.fromEntries(byBaba),
        };
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(obj, null, 2), 'utf-8');
        console.log(`Saved: ${out}`);
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
