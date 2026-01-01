import fs from 'fs';
import path from 'path';

type System = 'JRA' | 'NAR';
type RaceSpec = { raceId: string; system: System };

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

function makeRng(seed: number): () => number {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function writeJson(p: string, obj: any): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

function dedupe(items: RaceSpec[]): RaceSpec[] {
    const m = new Map<string, RaceSpec>();
    for (const it of items) {
        if (!it?.raceId || !it?.system) continue;
        const key = `${it.system}:${it.raceId}`;
        if (!m.has(key)) m.set(key, it);
    }
    return [...m.values()];
}

function splitOne(items: RaceSpec[], ratio: number, rng: () => number): { train: RaceSpec[]; holdout: RaceSpec[] } {
    const a = shuffle(items, rng);
    if (a.length <= 1) return { train: a, holdout: [] };

    let nTrain = Math.floor(a.length * ratio);
    nTrain = Math.max(1, Math.min(a.length - 1, nTrain)); // 両方1件以上（可能なら）
    return { train: a.slice(0, nTrain), holdout: a.slice(nTrain) };
}

async function main() {
    const inFile = arg('--in', path.join('data', 'backtest_races.json'))!;
    const trainOut = arg('--train', path.join('data', 'backtest_train.json'))!;
    const holdOut = arg('--holdout', path.join('data', 'backtest_holdout.json'))!;
    const ratio = parseRatio(arg('--ratio'), 0.8);
    const seed = Number(arg('--seed', '12345')) || 12345;
    const stratify = (arg('--stratify', 'system') || 'system').toLowerCase(); // system|none

    const raw = JSON.parse(fs.readFileSync(inFile, 'utf-8')) as RaceSpec[];
    const items = dedupe(Array.isArray(raw) ? raw : []);
    if (items.length === 0) {
        console.log(`No races in ${inFile}.`);
        process.exit(0);
    }

    const rng = makeRng(seed);

    let train: RaceSpec[] = [];
    let holdout: RaceSpec[] = [];

    if (stratify === 'none') {
        ({ train, holdout } = splitOne(items, ratio, rng));
    } else {
        // stratify by system
        const by = new Map<System, RaceSpec[]>();
        for (const it of items) {
            const arr = by.get(it.system) ?? [];
            arr.push(it);
            by.set(it.system, arr);
        }
        for (const [, arr] of by.entries()) {
            const sp = splitOne(arr, ratio, rng);
            train.push(...sp.train);
            holdout.push(...sp.holdout);
        }
        train = shuffle(train, rng);
        holdout = shuffle(holdout, rng);
    }

    // leakage check
    const sTrain = new Set(train.map(x => `${x.system}:${x.raceId}`));
    const sHold = new Set(holdout.map(x => `${x.system}:${x.raceId}`));
    let leak = 0;
    for (const k of sTrain) if (sHold.has(k)) leak++;
    if (leak > 0) {
        throw new Error(`Leakage detected: ${leak}`);
    }

    writeJson(trainOut, train);
    writeJson(holdOut, holdout);

    const countBy = (arr: RaceSpec[]) => arr.reduce((m, r) => (m[r.system] = (m[r.system] ?? 0) + 1, m), {} as Record<string, number>);
    console.log('--- split done ---');
    console.log(`in=${items.length} train=${train.length} holdout=${holdout.length} ratio=${ratio} seed=${seed} stratify=${stratify}`);
    console.log('train by system:', countBy(train));
    console.log('holdout by system:', countBy(holdout));
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
