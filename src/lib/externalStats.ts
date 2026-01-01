// src/lib/externalStats.ts
// db.netkeiba.com から騎手/調教師の統計（勝率/複勝率等）を取得

import * as cheerio from 'cheerio';
import { fetchHtmlAuto } from './htmlFetch';
import { getOrSetCache } from './cache';

export interface PersonStats {
    kind: 'jockey' | 'trainer';
    sourceUrl: string;
    fetchedAtJst: string;
    winRate: number | null;    // 0..1
    placeRate: number | null;  // 0..1 複勝率
    sample: number | null;
    note?: string;
}

export function canonicalDbUrl(url: string, kind: 'jockey' | 'trainer'): string | null {
    if (!url) return null;
    // 既にdb形式
    if (url.includes('db.netkeiba.com') && url.includes(`/${kind}/`)) return url;

    // id=12345
    const m1 = url.match(/[?&]id=(\d{4,6})/);
    if (m1) return `https://db.netkeiba.com/${kind}/${m1[1]}/`;

    // /jockey/12345/ 等
    const re = new RegExp(`/${kind}/(\\d{4,6})/`);
    const m2 = url.match(re);
    if (m2) return `https://db.netkeiba.com/${kind}/${m2[1]}/`;

    return null;
}

function findPercent(text: string, label: string): number | null {
    const t = text.replace(/\s+/g, '');
    // 例: "勝率10.2%" "複勝率28.7%"
    const re = new RegExp(`${label}[^0-9]*([0-9]+(?:\\.[0-9]+)?)[%％]`);
    const m = t.match(re);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v / 100 : null;
}

function findSample(text: string): number | null {
    const t = text.replace(/\s+/g, '');
    const m = t.match(/(?:騎乗回数|出走回数|総数)[^0-9]*([0-9,]+)/);
    if (!m) return null;
    const v = parseInt(m[1].replace(/,/g, ''), 10);
    return Number.isFinite(v) ? v : null;
}

async function fetchPerson(kind: 'jockey' | 'trainer', rawUrl: string, ttlMs: number): Promise<PersonStats | null> {
    const url = canonicalDbUrl(rawUrl, kind);
    if (!url) return null;

    return getOrSetCache<PersonStats>(`db:${kind}:${url}`, ttlMs, async () => {
        const res = await fetchHtmlAuto(url);
        const $ = cheerio.load(res.html);

        // HTML構造が変わっても拾えるようにbody全文から抽出
        const text = $('body').text() || res.html;
        const winRate = findPercent(text, '勝率');
        const placeRate = findPercent(text, '複勝率');
        const sample = findSample(text);

        let note: string | undefined;
        if (winRate == null && placeRate == null) {
            note = '勝率/複勝率が抽出できず（HTML構造変更の可能性）';
        }

        return {
            kind,
            sourceUrl: res.url,
            fetchedAtJst: res.fetchedAtJst,
            winRate,
            placeRate,
            sample,
            note,
        };
    });
}

export async function fetchJockeyStats(url: string, ttlMs = 7 * 24 * 3600 * 1000): Promise<PersonStats | null> {
    return fetchPerson('jockey', url, ttlMs);
}

export async function fetchTrainerStats(url: string, ttlMs = 7 * 24 * 3600 * 1000): Promise<PersonStats | null> {
    return fetchPerson('trainer', url, ttlMs);
}
