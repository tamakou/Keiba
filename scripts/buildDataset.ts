import fs from 'fs';
import path from 'path';

import { getRaceList } from '../src/lib/netkeiba';
import { fetchRaceResult, System } from '../src/lib/resultParser';

type RaceSpec = { raceId: string; system: System };

function arg(name: string, def?: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return def;
}

function normalizeDate(s: string): string {
    const t = (s || '').replace(/[-\/]/g, '');
    if (!/^\d{8}$/.test(t)) throw new Error(`Invalid date: ${s}`);
    return t;
}

function nextDay(yyyymmdd: string): string {
    const y = parseInt(yyyymmdd.slice(0, 4), 10);
    const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
    const d = parseInt(yyyymmdd.slice(6, 8), 10);
    const dt = new Date(Date.UTC(y, m, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
}

function writeJson(p: string, obj: unknown): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function main() {
    const start = normalizeDate(arg('--start', '') || '');
    const end = normalizeDate(arg('--end', '') || '');
    const outFile = arg('--out', path.join('data', 'backtest_races.json'))!;
    const systems = (arg('--systems', 'both') || 'both').toLowerCase(); // jra|nar|both
    const maxPerDay = Number(arg('--max_per_day', '999')) || 999;

    if (!start || !end) {
        console.log('Usage: --start YYYYMMDD --end YYYYMMDD [--systems jra|nar|both] [--max_per_day N]');
        process.exit(1);
    }

    console.log(`Collecting races from ${start} to ${end} (systems=${systems}, maxPerDay=${maxPerDay})`);

    const list: RaceSpec[] = [];
    const seen = new Set<string>();

    let cur = start;
    while (cur <= end) {
        try {
            const races = await getRaceList(cur); // NAR+JRA統合
            const filtered = races.filter(r => {
                const sys = ((r as unknown as { system?: string }).system || 'NAR') as System;
                if (systems === 'jra') return sys === 'JRA';
                if (systems === 'nar') return sys === 'NAR';
                return true;
            }).slice(0, maxPerDay);

            for (const r of filtered) {
                const sys = ((r as unknown as { system?: string }).system || 'NAR') as System;
                const key = `${sys}:${r.id}`;
                if (seen.has(key)) continue;

                // 結果があるレースだけ採用（確定済みを収集）
                const res = await fetchRaceResult(r.id, sys);
                if (!res || !res.order?.length) continue;

                seen.add(key);
                list.push({ raceId: r.id, system: sys });
            }

            console.log(`[${cur}] collected=${list.length}`);
        } catch (e) {
            console.log(`[${cur}] skip: ${e}`);
        }

        cur = nextDay(cur);
    }

    writeJson(outFile, list);
    console.log(`Saved: ${outFile} (${list.length} races)`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
