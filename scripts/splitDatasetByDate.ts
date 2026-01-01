import fs from 'fs';
import path from 'path';
import { getRaceDetails } from '../src/lib/netkeiba';
import { Race } from '../src/lib/types';

type System = 'JRA' | 'NAR';
type RaceSpec = { raceId: string; system: System; date?: string };

function arg(name: string, def?: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return def;
}

function parseRatio(s: string | undefined, def = 0.8): number {
    const x = s ? Number(s) : NaN;
    if (!Number.isFinite(x)) return def;
    return Math.max(0.05, Math.min(0.95, x));
}

function normalizeDate(s: string | undefined): string | null {
    if (!s) return null;
    const t = s.replace(/[-\/]/g, '');
    if (!/^\d{8}$/.test(t)) return null;
    const y = parseInt(t.slice(0, 4), 10);
    const m = parseInt(t.slice(4, 6), 10);
    const d = parseInt(t.slice(6, 8), 10);
    if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    return t;
}

function guessDateFromRaceId(raceId: string): string | null {
    // 先頭8桁がYYYYMMDDっぽいなら採用
    const m = raceId.match(/^(\d{8})/);
    if (!m) return null;
    return normalizeDate(m[1]);
}

function cacheDir(): string {
    return process.env.KEIBA_BT_CACHE_DIR || '.keiba_backtest_cache';
}

function cachePath(kind: 'race', system: System, raceId: string): string {
    return path.join(cacheDir(), `${kind}_${system}_${raceId}.json`);
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

async function getDateFor(spec: RaceSpec): Promise<string | null> {
    // 1) dataset entry
    const d0 = normalizeDate(spec.date);
    if (d0) return d0;

    // 2) guess from raceId
    const g = guessDateFromRaceId(spec.raceId);
    if (g) return g;

    // 3) fetch race details (cached)
    const p = cachePath('race', spec.system, spec.raceId);
    let race = readJsonIfExists<Race>(p);
    if (!race) {
        const r = await getRaceDetails(spec.raceId, spec.system);
        if (!r) return null;
        race = r;
        writeJson(p, race);
    }
    return normalizeDate((race as unknown as { date?: string }).date);
}

function writeList(p: string, list: unknown[]): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(list, null, 2) + '\n', 'utf-8');
}

async function main() {
    const inFile = arg('--in', path.join('data', 'backtest_races.json'))!;
    const trainOut = arg('--train', path.join('data', 'backtest_train_time.json'))!;
    const holdOut = arg('--holdout', path.join('data', 'backtest_holdout_time.json'))!;
    const ratio = parseRatio(arg('--ratio'), 0.8);
    const cutoff = normalizeDate(arg('--cutoff')); // optional
    const perSystem = (arg('--per_system', '1') !== '0');

    const raw = JSON.parse(fs.readFileSync(inFile, 'utf-8')) as RaceSpec[];
    const items = Array.isArray(raw) ? raw : [];
    if (items.length === 0) {
        console.log(`No races in ${inFile}.`);
        process.exit(0);
    }

    console.log(`Processing ${items.length} races from ${inFile}...`);

    const enriched: Array<RaceSpec & { dateKey: string }> = [];
    const unknown: RaceSpec[] = [];

    for (const it of items) {
        const dk = await getDateFor(it);
        if (!dk) unknown.push({ raceId: it.raceId, system: it.system });
        else enriched.push({ ...it, dateKey: dk });
    }

    const splitGroup = (arr: Array<RaceSpec & { dateKey: string }>) => {
        const s = arr.slice().sort((a, b) => a.dateKey.localeCompare(b.dateKey));
        if (cutoff) {
            const train = s.filter(x => x.dateKey < cutoff);
            const hold = s.filter(x => x.dateKey >= cutoff);
            return { train, hold };
        }
        const nTrain = Math.max(1, Math.min(s.length - 1, Math.floor(s.length * ratio)));
        return { train: s.slice(0, nTrain), hold: s.slice(nTrain) };
    };

    let train: RaceSpec[] = [];
    let hold: RaceSpec[] = [];

    if (perSystem) {
        const by = new Map<System, Array<RaceSpec & { dateKey: string }>>();
        for (const e of enriched) {
            const a = by.get(e.system) ?? [];
            a.push(e);
            by.set(e.system, a);
        }
        for (const [, arr] of by.entries()) {
            const sp = splitGroup(arr);
            train.push(...sp.train.map(x => ({ raceId: x.raceId, system: x.system })));
            hold.push(...sp.hold.map(x => ({ raceId: x.raceId, system: x.system })));
        }
    } else {
        const sp = splitGroup(enriched);
        train = sp.train.map(x => ({ raceId: x.raceId, system: x.system }));
        hold = sp.hold.map(x => ({ raceId: x.raceId, system: x.system }));
    }

    writeList(trainOut, train);
    writeList(holdOut, hold);

    console.log('--- time split done ---');
    console.log(`in=${items.length} dated=${enriched.length} unknown=${unknown.length}`);
    console.log(`train=${train.length} holdout=${hold.length} perSystem=${perSystem} ratio=${ratio} cutoff=${cutoff ?? '(none)'}`);
    if (unknown.length > 0) {
        console.log(`unknown examples:`, unknown.slice(0, 5));
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
