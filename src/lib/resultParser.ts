// src/lib/resultParser.ts
// レース結果（全着順）＋払戻をパースするユーティリティ

import * as cheerio from 'cheerio';
import { fetchHtmlAuto } from './htmlFetch';
import type { BetType } from './types';

export type System = 'JRA' | 'NAR';

export interface PayoutEntry {
    key: string;            // 単勝/複勝: "4"  ワイド/馬連: "4-6"  馬単: "6>4"  三連複: "4-6-12"  三連単: "6>4>12"
    payoutYen: number;      // 100円あたりの払戻（円）
    popularity: number | null;
    raw: { combo: string; payoutText: string; popText?: string };
}

export type Payouts = Partial<Record<BetType, PayoutEntry[]>>;

export interface RaceResult {
    raceId: string;
    system: System;
    sourceUrl: string;
    fetchedAtJst: string;
    order: number[]; // 着順でソート済み（取消/除外などは除外される）
    top3: number[];
    rankByUmaban: Record<string, number>;
    payouts?: Payouts;
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

function parseMoneyMinYen(text: string): number | null {
    const s = (text || '').replace(/,/g, '');
    const nums = (s.match(/\d+/g) || []).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0);
    if (nums.length === 0) return null;
    return Math.min(...nums); // 範囲表記/同着などがあっても保守的にmin
}

function normalizeCombo(type: BetType, raw: string): string | null {
    const nums = (raw.match(/\d{1,2}/g) || []).map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n >= 1);
    if (type === '単勝' || type === '複勝') {
        if (nums.length < 1) return null;
        return String(nums[0]);
    }
    if (type === 'ワイド' || type === '馬連') {
        if (nums.length < 2) return null;
        const a = Math.min(nums[0], nums[1]);
        const b = Math.max(nums[0], nums[1]);
        return `${a}-${b}`;
    }
    if (type === '馬単') {
        if (nums.length < 2) return null;
        return `${nums[0]}>${nums[1]}`;
    }
    if (type === '三連複') {
        if (nums.length < 3) return null;
        const s = [nums[0], nums[1], nums[2]].sort((a, b) => a - b);
        return `${s[0]}-${s[1]}-${s[2]}`;
    }
    if (type === '三連単') {
        if (nums.length < 3) return null;
        return `${nums[0]}>${nums[1]}>${nums[2]}`;
    }
    return null;
}

function linesFromCell($cell: any): string[] {
    const html = ($cell.html?.() || '').replace(/<br\s*\/?>/gi, '\n');
    const txt = cheerio.load(`<x>${html}</x>`)('x').text();
    return txt.split(/\n+/).map(s => s.trim()).filter(Boolean);
}

function parsePayouts($: cheerio.CheerioAPI): Payouts {
    const TYPES: BetType[] = ['単勝', '複勝', 'ワイド', '馬連', '馬単', '三連複', '三連単'];
    const out: Payouts = {};

    $('tr').each((_, tr) => {
        const $tr = $(tr);
        const cells = $tr.children('th,td').toArray();
        if (cells.length < 3) return;

        const typeText = $(cells[0]).text().trim().replace(/\s+/g, '');
        const type = TYPES.find(t => typeText === t || typeText.includes(t));
        if (!type) return;

        const combos = linesFromCell($(cells[1]));
        const pays = linesFromCell($(cells[2]));
        const pops = cells.length >= 4 ? linesFromCell($(cells[3])) : [];

        const m = Math.min(combos.length, pays.length);
        for (let i = 0; i < m; i++) {
            const key = normalizeCombo(type, combos[i]);
            const payout = parseMoneyMinYen(pays[i]);
            const pop = pops[i] ? parseInt(pops[i].replace(/\D/g, ''), 10) : NaN;

            if (!key || payout == null) continue;
            (out[type] ||= []).push({
                key,
                payoutYen: payout,
                popularity: Number.isFinite(pop) ? pop : null,
                raw: { combo: combos[i], payoutText: pays[i], popText: pops[i] }
            });
        }
    });

    return out;
}

export async function fetchRaceResult(raceId: string, system: System): Promise<RaceResult | null> {
    const base = system === 'JRA' ? 'https://race.netkeiba.com' : 'https://nar.netkeiba.com';
    const url = `${base}/race/result.html?race_id=${raceId}`;
    const res = await fetchHtmlAuto(url);
    const $ = cheerio.load(res.html);

    // --- 着順 ---
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

        const rankText = $tr.find('td.Rank').text().trim() || $(tds[0]).text().trim();
        const rank = parseRank(rankText);
        if (rank == null) continue;

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

    const pairs = [...rankMap.entries()].sort((a, b) => a[1] - b[1]);
    const order = pairs.map(p => p[0]);
    const top3 = order.slice(0, 3);

    const rankByUmaban: Record<string, number> = {};
    for (const [u, r] of rankMap.entries()) rankByUmaban[String(u)] = r;

    // --- 払戻 ---
    const payouts = parsePayouts($);
    const hasPayout = Object.keys(payouts).length > 0;

    return {
        raceId,
        system,
        sourceUrl: res.url,
        fetchedAtJst: res.fetchedAtJst,
        order,
        top3,
        rankByUmaban,
        payouts: hasPayout ? payouts : undefined,
    };
}
