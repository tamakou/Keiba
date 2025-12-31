// src/lib/oddsProvider.ts
import * as cheerio from 'cheerio';
import { BetType, DataSource, OddsEntry, OddsTable, OddsTables, RaceSystem } from './types';
import { fetchHtmlAuto } from './htmlFetch';

const BASES = {
    NAR: 'https://nar.netkeiba.com',
    JRA: 'https://race.netkeiba.com',
} as const;

const FALLBACK_TYPE_CODE: Partial<Record<BetType, string>> = {
    '単勝': 'b1',
    '複勝': 'b1', // 単勝複勝は同ページ
    '馬連': 'b4',
    'ワイド': 'b5',
    '馬単': 'b6',
    '三連複': 'b7',
    '三連単': 'b8',
};

function absUrl(base: string, href: string): string {
    return new URL(href, base).toString();
}

function parseOddsEntry(rawText: string): OddsEntry {
    const raw = rawText.trim();
    // カンマを除去してから処理（1,234.5 → 1234.5）
    const compact = raw.replace(/\s/g, '').replace(/,/g, '');

    // 数値抽出（複勝レンジ対応）
    const nums = compact.match(/\d+(\.\d+)?/g);
    if (!nums || nums.length === 0) return { raw, value: null, min: null, max: null };

    if (nums.length === 1) {
        const v = parseFloat(nums[0]);
        return Number.isFinite(v) ? { raw, value: v, min: null, max: null } : { raw, value: null, min: null, max: null };
    }

    const a = parseFloat(nums[0]);
    const b = parseFloat(nums[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { raw, value: null, min: null, max: null };
    return { raw, value: null, min: Math.min(a, b), max: Math.max(a, b) };
}

function findOddsUrlsFromIndex(html: string, base: string): Partial<Record<BetType, string>> {
    const $ = cheerio.load(html);
    const found: Partial<Record<BetType, string>> = {};

    const targets: BetType[] = ['単勝', '複勝', 'ワイド', '馬連', '馬単', '三連複', '三連単'];

    $('a').each((_, a) => {
        const text = $(a).text().trim();
        const href = $(a).attr('href') || '';
        if (!href.includes('odds') || !href.includes('race_id')) return;

        for (const t of targets) {
            if (!found[t] && text.includes(t)) {
                found[t] = absUrl(base, href);
            }
        }
    });

    return found;
}

function parseSingleOdds(html: string): Record<string, OddsEntry> {
    const $ = cheerio.load(html);
    const odds: Record<string, OddsEntry> = {};

    $('tr').each((_, tr) => {
        const cells = $(tr).find('th,td').map((_, c) => $(c).text().trim()).get();
        if (cells.length < 2) return;

        const numCell = cells.find(c => /^\d{1,2}$/.test(c));
        if (!numCell) return;
        const num = parseInt(numCell, 10);
        if (!(num >= 1 && num <= 20)) return;

        // oddsっぽいセル
        const oddsCell = cells.find(c => /\d/.test(c) && (c.includes('.') || c.includes('〜') || c.includes('～') || c.includes('-')));
        if (!oddsCell) return;

        const entry = parseOddsEntry(oddsCell);
        if (entry.value !== null || entry.min !== null) {
            odds[String(num)] = entry;
        }
    });

    return odds;
}

function parsePairListOdds(html: string): Record<string, OddsEntry> {
    const $ = cheerio.load(html);
    const odds: Record<string, OddsEntry> = {};

    $('tr').each((_, tr) => {
        const text = $(tr).text().replace(/\s/g, '');
        const m = text.match(/(\d{1,2})[-－](\d{1,2})/);
        if (!m) return;

        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        if (!(a >= 1 && b >= 1)) return;

        const floats = text.match(/\d+\.\d+/g);
        const raw = floats?.slice(-1)?.[0];
        if (!raw) return;

        const v = parseFloat(raw);
        if (!Number.isFinite(v)) return;

        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        odds[key] = { raw, value: v, min: null, max: null };
    });

    return odds;
}

function parsePairMatrixOdds(html: string): Record<string, OddsEntry> {
    const $ = cheerio.load(html);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let best: any = null;
    let bestCols: number[] = [];

    $('table').each((_, tbl) => {
        const $tbl = $(tbl);
        const header = $tbl.find('tr').first().find('th,td').map((_, c) => $(c).text().trim()).get();
        const nums = header.map(t => parseInt(t, 10)).filter(n => Number.isFinite(n) && n >= 1 && n <= 20);
        if (nums.length >= 4 && nums.length > bestCols.length) {
            best = $tbl;
            bestCols = nums;
        }
    });

    if (!best) return parsePairListOdds(html);

    const odds: Record<string, OddsEntry> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    best.find('tr').slice(1).each((_: number, tr: any) => {
        const $tr = $(tr);

        const rowHeadText = $tr.find('th,td').first().text().trim();
        const rowNum = parseInt(rowHeadText, 10);
        if (!(rowNum >= 1 && rowNum <= 20)) return;

        let dataCells = $tr.find('td').map((_, c) => $(c).text().trim()).get();
        if (dataCells.length === bestCols.length + 1) dataCells = dataCells.slice(1);

        for (let i = 0; i < Math.min(bestCols.length, dataCells.length); i++) {
            const colNum = bestCols[i];
            if (colNum === rowNum) continue;

            const entry = parseOddsEntry(dataCells[i]);
            if (entry.value !== null) {
                const key = rowNum < colNum ? `${rowNum}-${colNum}` : `${colNum}-${rowNum}`;
                odds[key] = entry;
            }
        }
    });

    return Object.keys(odds).length ? odds : parsePairListOdds(html);
}

function parseTrioListOdds(html: string): Record<string, OddsEntry> {
    const $ = cheerio.load(html);
    const odds: Record<string, OddsEntry> = {};

    $('tr').each((_, tr) => {
        const text = $(tr).text().replace(/\s/g, '');
        const m = text.match(/(\d{1,2})[-－](\d{1,2})[-－](\d{1,2})/);
        if (!m) return;

        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        const c = parseInt(m[3], 10);

        const floats = text.match(/\d+\.\d+/g);
        const raw = floats?.slice(-1)?.[0];
        if (!raw) return;

        const v = parseFloat(raw);
        if (!Number.isFinite(v)) return;

        const arr = [a, b, c].sort((x, y) => x - y);
        const key = `${arr[0]}-${arr[1]}-${arr[2]}`;
        odds[key] = { raw, value: v, min: null, max: null };
    });

    return odds;
}

function parseTrifectaListOdds(html: string): Record<string, OddsEntry> {
    const $ = cheerio.load(html);
    const odds: Record<string, OddsEntry> = {};

    $('tr').each((_, tr) => {
        const text = $(tr).text().replace(/\s/g, '');
        const m = text.match(/(\d{1,2})[→>](\d{1,2})[→>](\d{1,2})/);
        if (!m) return;

        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        const c = parseInt(m[3], 10);

        const floats = text.match(/\d+\.\d+/g);
        const raw = floats?.slice(-1)?.[0];
        if (!raw) return;

        const v = parseFloat(raw);
        if (!Number.isFinite(v)) return;

        const key = `${a}>${b}>${c}`;
        odds[key] = { raw, value: v, min: null, max: null };
    });

    return odds;
}

/** NAR "人気順" 表示をパース。RaceOdds_HorseList_Table構造対応 */
function parseOddsListTable(html: string, type: BetType): Record<string, OddsEntry> {
    const $ = cheerio.load(html);
    const odds: Record<string, OddsEntry> = {};

    // NAR の実際のテーブル構造: RaceOdds_HorseList_Table
    const table = $('table.RaceOdds_HorseList_Table').first();
    const rows = table.length ? table.find('tr') : $('tr');

    // キー生成
    const buildKey = (nums: number[]): string | null => {
        if (type === '馬単') {
            if (nums.length !== 2) return null;
            return `${nums[0]}>${nums[1]}`;
        }
        if (type === '三連単') {
            if (nums.length !== 3) return null;
            return `${nums[0]}>${nums[1]}>${nums[2]}`;
        }
        if (type === '三連複') {
            if (nums.length !== 3) return null;
            const s = [...nums].sort((a, b) => a - b);
            return `${s[0]}-${s[1]}-${s[2]}`;
        }
        // ワイド/馬連
        if (nums.length !== 2) return null;
        const a = Math.min(nums[0], nums[1]);
        const b = Math.max(nums[0], nums[1]);
        return `${a}-${b}`;
    };

    rows.each((_, tr) => {
        const $tr = $(tr);

        // 方法1: td.Combi + td.Txt_R (NAR標準構造)
        const combiCell = $tr.find('td.Combi');
        const oddsCell = $tr.find('td.Txt_R');

        if (combiCell.length && oddsCell.length) {
            // span.UmaBan から馬番を取得
            const umabans = combiCell.find('span.UmaBan');
            const nums: number[] = [];
            umabans.each((_, span) => {
                const n = parseInt($(span).text().trim(), 10);
                if (Number.isFinite(n) && n >= 1) nums.push(n);
            });

            // span.UmabanがなければテキストからDigitを抽出
            if (nums.length === 0) {
                const combiText = combiCell.text().replace(/\s+/g, ' ').trim();
                const digitMatches = combiText.match(/\d+/g);
                if (digitMatches) {
                    for (const d of digitMatches) {
                        const n = parseInt(d, 10);
                        if (Number.isFinite(n) && n >= 1 && n <= 20) nums.push(n);
                    }
                }
            }

            const key = buildKey(nums);
            if (!key) return;

            const oddsText = oddsCell.text().trim();
            const entry = parseOddsEntry(oddsText);
            if (entry.value !== null || entry.min !== null) {
                odds[key] = entry;
            }
            return;
        }

        // 方法2: フォールバック - 行全体からパース
        const tds = $tr.find('td');
        if (!tds.length) return;

        const tdTexts = tds.map((_, td) => $(td).text().trim()).get();

        // 数字セルを探す（最初の3つまたは2つの数字）
        const nums: number[] = [];
        for (const text of tdTexts) {
            // 単一数字のセル（馬番）
            const singleMatch = text.match(/^(\d{1,2})$/);
            if (singleMatch) {
                const n = parseInt(singleMatch[1], 10);
                if (Number.isFinite(n) && n >= 1 && n <= 20 && nums.length < 3) {
                    nums.push(n);
                }
            }
        }

        // 数字が足りなければ、Digitを含むセルから抽出
        if (nums.length < 2) {
            const rowText = $tr.text();
            const allNums = rowText.match(/\d+/g);
            if (allNums) {
                for (const d of allNums) {
                    const n = parseInt(d, 10);
                    if (Number.isFinite(n) && n >= 1 && n <= 20 && !nums.includes(n)) {
                        nums.push(n);
                        if (nums.length >= (type === '三連複' || type === '三連単' ? 3 : 2)) break;
                    }
                }
            }
        }

        const key = buildKey(nums);
        if (!key) return;

        // オッズは小数点を含むセルを探す
        const oddsText = tdTexts.find(t => /\d+\.\d+/.test(t));
        if (!oddsText) return;

        const entry = parseOddsEntry(oddsText);
        if (entry.value !== null || entry.min !== null) {
            odds[key] = entry;
        }
    });

    return odds;
}


function parseOddsPage(type: BetType, html: string): Record<string, OddsEntry> {
    if (type === '単勝' || type === '複勝') return parseSingleOdds(html);
    // 組み合わせ券種は人気順リスト形式をパース
    if (['ワイド', '馬連', '馬単', '三連複', '三連単'].includes(type)) {
        const result = parseOddsListTable(html, type);
        // フォールバック: リストテーブルでパースできなかった場合は旧パーサー
        if (Object.keys(result).length === 0) {
            if (type === 'ワイド' || type === '馬連') return parsePairMatrixOdds(html);
            if (type === '三連複') return parseTrioListOdds(html);
            if (type === '三連単' || type === '馬単') return parseTrifectaListOdds(html);
        }
        return result;
    }
    return {};
}

export async function fetchRaceOddsTables(
    raceId: string,
    system: RaceSystem = 'NAR'
): Promise<{ tables: OddsTables; sources: DataSource[] }> {
    const sources: DataSource[] = [];
    const tables: OddsTables = {};

    const base = BASES[system];
    const indexUrl = `${base}/odds/index.html?race_id=${raceId}`;
    let indexHtml = '';

    try {
        const idx = await fetchHtmlAuto(indexUrl);
        indexHtml = idx.html;
        sources.push({ url: idx.url, fetchedAtJst: idx.fetchedAtJst, items: [`${system.toLowerCase()}_odds_index`] });
    } catch (e) {
        sources.push({ url: indexUrl, fetchedAtJst: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }), items: [`${system.toLowerCase()}_odds_index`], note: '取得失敗' });
        return { tables, sources };
    }

    const foundUrls = findOddsUrlsFromIndex(indexHtml, base);

    const targets: BetType[] = ['単勝', '複勝', 'ワイド', '馬連', '馬単', '三連複', '三連単'];

    for (const t of targets) {
        let url = foundUrls[t] || (FALLBACK_TYPE_CODE[t] ? `${indexUrl}&type=${FALLBACK_TYPE_CODE[t]}` : null);
        if (!url) continue;
        // 組み合わせ券種は人気順表示（housiki=c99）を取得するとパースしやすい（NARのみ）
        if (system === 'NAR' && ['ワイド', '馬連', '馬単', '三連複', '三連単'].includes(t) && !url.includes('housiki=')) {
            url += '&housiki=c99';
        }

        try {
            const res = await fetchHtmlAuto(url);
            sources.push({ url: res.url, fetchedAtJst: res.fetchedAtJst, items: [`odds:${t}`] });

            const odds = parseOddsPage(t, res.html);
            if (Object.keys(odds).length === 0) {
                tables[t] = { type: t, url: res.url, fetchedAtJst: res.fetchedAtJst, odds: {}, note: 'パース結果が空（HTML構造要調整の可能性）' };
            } else {
                tables[t] = { type: t, url: res.url, fetchedAtJst: res.fetchedAtJst, odds };
            }
        } catch (e) {
            sources.push({ url, fetchedAtJst: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }), items: [`odds:${t}`], note: '取得失敗' });
        }
    }

    return { tables, sources };
}
