// src/lib/resultParser.ts
// レース結果（全着順）をパースするユーティリティ

import * as cheerio from 'cheerio';
import { fetchHtmlAuto } from './htmlFetch';

export type System = 'JRA' | 'NAR';

export interface RaceResult {
    raceId: string;
    system: System;
    sourceUrl: string;
    fetchedAtJst: string;
    // 着順でソート済み（取消/除外などは除外される）
    order: number[];
    top3: number[];
    // umaban -> rank
    rankByUmaban: Record<string, number>;
}

function parseRank(text: string): number | null {
    const m = (text || '').trim().match(/^(\d+)/);
    if (!m) return null;
    const r = parseInt(m[1], 10);
    return Number.isFinite(r) && r >= 1 ? r : null;
}

function parseUmaban(text: string): number | null {
    const t = (text || '').trim();
    if (!t) return null;
    const m = t.match(/^(\d{1,2})$/);
    if (!m) return null;
    const u = parseInt(m[1], 10);
    return Number.isFinite(u) && u >= 1 ? u : null;
}

export async function fetchRaceResult(raceId: string, system: System): Promise<RaceResult | null> {
    const base = system === 'JRA' ? 'https://race.netkeiba.com' : 'https://nar.netkeiba.com';
    const url = `${base}/race/result.html?race_id=${raceId}`;
    const res = await fetchHtmlAuto(url);
    const $ = cheerio.load(res.html);

    // まずはありがちなテーブルを優先、なければ全tableから最大行のもの
    const preferred = ['table.RaceTable01', 'table.Result_Table', 'table#All_Result_Table'];
    let rows: any[] = [];

    for (const sel of preferred) {
        const r = $(sel).find('tr').toArray();
        if (r.length > rows.length) rows = r;
    }
    if (rows.length === 0) {
        const all = $('table').toArray();
        for (const t of all) {
            const r = $(t).find('tr').toArray();
            if (r.length > rows.length) rows = r;
        }
    }

    const rankMap = new Map<number, number>(); // umaban -> best rank

    for (const tr of rows) {
        const $tr = $(tr);
        const tds = $tr.find('td').toArray();
        if (tds.length < 2) continue;

        const rankText =
            $tr.find('td.Rank').text().trim() ||
            $(tds[0]).text().trim();
        const rank = parseRank(rankText);
        if (rank == null) continue;

        // umaban候補：クラス優先 → それでもダメなら "数字だけ" セルを探す
        const umabanText =
            $tr.find('td.Umaban').text().trim() ||
            $tr.find('.Umaban').text().trim() ||
            $tr.find('td.Num').text().trim();

        let umaban = parseUmaban(umabanText);
        if (umaban == null) {
            for (const td of tds) {
                const u = parseUmaban($(td).text());
                if (u != null) { umaban = u; break; }
            }
        }
        if (umaban == null) continue;

        const prev = rankMap.get(umaban);
        if (prev == null || rank < prev) rankMap.set(umaban, rank);
    }

    if (rankMap.size === 0) return null;

    const pairs = [...rankMap.entries()].sort((a, b) => a[1] - b[1]); // rank asc
    const order = pairs.map(p => p[0]);
    const top3 = order.slice(0, 3);

    const rankByUmaban: Record<string, number> = {};
    for (const [u, r] of rankMap.entries()) rankByUmaban[String(u)] = r;

    return {
        raceId,
        system,
        sourceUrl: res.url,
        fetchedAtJst: res.fetchedAtJst,
        order,
        top3,
        rankByUmaban,
    };
}
