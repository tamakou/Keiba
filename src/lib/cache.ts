// src/lib/cache.ts
// シンプルなTTLキャッシュ（in-memory + 任意でFS）

import fs from 'fs';
import path from 'path';

type Entry<T> = { value: T; expiresAt: number };
const mem = new Map<string, Entry<any>>();
const inFlight = new Map<string, Promise<any>>();

function now(): number {
    return Date.now();
}

function fsEnabled(): boolean {
    return process.env.KEIBA_CACHE_FS === '1';
}

function cacheDir(): string {
    return path.join(process.cwd(), '.keiba_cache');
}

function keyToPath(key: string): string {
    // ファイル名安全化
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(cacheDir(), `${safe}.json`);
}

export function getCache<T>(key: string): T | null {
    // 1) in-memory
    const e = mem.get(key);
    if (e) {
        if (now() <= e.expiresAt) return e.value as T;
        mem.delete(key);
    }

    // 2) filesystem（任意）
    if (fsEnabled()) {
        try {
            const p = keyToPath(key);
            if (!fs.existsSync(p)) return null;
            const raw = fs.readFileSync(p, 'utf-8');
            const obj = JSON.parse(raw) as Entry<T>;
            if (now() > obj.expiresAt) {
                fs.unlinkSync(p);
                return null;
            }
            // FSヒットはmemにも載せる
            mem.set(key, obj as any);
            return obj.value as T;
        } catch {
            return null;
        }
    }

    return null;
}

export function setCache<T>(key: string, value: T, ttlMs: number): void {
    const entry: Entry<T> = { value, expiresAt: now() + ttlMs };
    mem.set(key, entry as any);

    if (fsEnabled()) {
        try {
            fs.mkdirSync(cacheDir(), { recursive: true });
            fs.writeFileSync(keyToPath(key), JSON.stringify(entry), 'utf-8');
        } catch {
            // ignore
        }
    }
}

export async function getOrSetCache<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const hit = getCache<T>(key);
    if (hit != null) return hit;

    // in-flight dedupe: 同時に同じキーを取りに来た場合は既存のPromiseを返す
    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const p = (async () => {
        try {
            const v = await loader();
            setCache(key, v, ttlMs);
            return v;
        } finally {
            inFlight.delete(key);
        }
    })();

    inFlight.set(key, p);
    return p;
}

// 同時接続制限つきPromiseプール
export async function runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = [];
    let idx = 0;

    const n = Math.max(1, concurrency | 0);
    const runners = Array.from({ length: n }, async () => {
        while (idx < items.length) {
            const cur = items[idx++];
            const r = await worker(cur);
            results.push(r);
        }
    });

    await Promise.all(runners);
    return results;
}
