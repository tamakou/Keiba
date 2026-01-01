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

function inc(map: Map<string, number>, k: string): void {
    map.set(k, (map.get(k) ?? 0) + 1);
}

function topN(map: Map<string, number>, n = 20): [string, number][] {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function yyyymm(raceId: string): string {
    // raceIdの先頭8桁が YYYYMMDD の想定（違っても "unknown"）
    const m = (raceId || '').match(/^(\d{6})\d{2}/);
    return m ? m[1] : 'unknown';
}

async function main() {
    const file = arg('--data', path.join('data', 'backtest_races.json'))!;
    const fetchMeta = (arg('--fetch', '0') === '1');
    const out = arg('--out', '');

    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as RaceSpec[];
    const items = Array.isArray(raw) ? raw : [];

    const bySystem = new Map<string, number>();
    const byMonth = new Map<string, number>();
    const byVenue = new Map<string, number>();
    const bySurfaceDist = new Map<string, number>();
    const byBaba = new Map<string, number>();

    for (const it of items) {
        inc(bySystem, it.system);
        inc(byMonth, `${it.system}:${yyyymm(it.raceId)}`);
    }

    if (fetchMeta) {
        for (const it of items) {
            try {
                const race = await getRaceDetails(it.raceId, it.system);
                if (!race) continue;
                inc(byVenue, `${it.system}:${race.venue}`);
                const cd = parseRaceCourse(race.course);
                inc(bySurfaceDist, `${it.system}:${cd.surface}${cd.distance ?? '??'}:${cd.direction}`);
                inc(byBaba, `${it.system}:${normalizeBaba(race.baba)}`);
            } catch {
                // skip
            }
        }
    }

    const report: Record<string, unknown> = {
        total: items.length,
        system: Object.fromEntries(bySystem),
        monthTop: topN(byMonth, 24),
    };

    if (fetchMeta) {
        report.venueTop = topN(byVenue, 30);
        report.surfaceDistTop = topN(bySurfaceDist, 30);
        report.babaTop = topN(byBaba, 10);
    }

    console.log('--- Dataset Audit ---');
    console.log(JSON.stringify(report, null, 2));

    if (out && out.trim()) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf-8');
        console.log(`Saved: ${out}`);
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
