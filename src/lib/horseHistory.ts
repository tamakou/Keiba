// src/lib/horseHistory.ts
import * as cheerio from 'cheerio';
import { DataSource, Horse, HorseRun } from './types';
import { fetchHtmlAuto } from './htmlFetch';

function pickText(cells: string[], idx: number): string | null {
    if (idx < 0 || idx >= cells.length) return null;
    const v = cells[idx]?.trim();
    return v ? v : null;
}

export async function fetchHorseLast5(horseUrl: string): Promise<{ runs: HorseRun[] | null; source: DataSource }> {
    const res = await fetchHtmlAuto(horseUrl);
    const source: DataSource = { url: res.url, fetchedAtJst: res.fetchedAtJst, items: ['horse_last5'] };

    const $ = cheerio.load(res.html);

    // まずは定番テーブル（あれば）
    let table = $('table.db_h_race_results').first();

    // なければ「着順」「距離」などを含むテーブルを探索
    if (!table.length) {
        $('table').each((_, t) => {
            if (table.length) return;
            const head = $(t).find('tr').first().text();
            if (head.includes('着順') && (head.includes('距離') || head.includes('タイム') || head.includes('上がり') || head.includes('上り'))) {
                table = $(t);
            }
        });
    }

    if (!table.length) {
        source.note = '戦績テーブルが見つからず';
        return { runs: null, source };
    }

    const headers = table.find('tr').first().find('th,td').map((_, c) => $(c).text().trim()).get();

    const idxDate = headers.findIndex(h => h.includes('日付') || h.includes('年月日'));
    const idxVenue = headers.findIndex(h => h.includes('開催') || h.includes('場所') || h.includes('場'));
    const idxRace = headers.findIndex(h => h.includes('レース') || h.includes('レース名'));
    const idxClass = headers.findIndex(h => h.includes('クラス') || h.includes('条件'));
    const idxDist = headers.findIndex(h => h.includes('距離'));
    const idxFinish = headers.findIndex(h => h.includes('着順'));
    const idxTime = headers.findIndex(h => h.includes('タイム') || h.includes('時計'));
    const idxLast3f = headers.findIndex(h => h.includes('上がり') || h.includes('上り') || h.includes('上3F'));

    const runs: HorseRun[] = [];

    table.find('tr').slice(1).each((_, tr) => {
        if (runs.length >= 5) return false;

        const cells = $(tr).find('th,td').map((_, c) => $(c).text().trim()).get();
        if (!cells.join('').trim()) return;

        runs.push({
            date: pickText(cells, idxDate),
            venue: pickText(cells, idxVenue),
            raceName: pickText(cells, idxRace),
            class: pickText(cells, idxClass),
            surfaceDistance: pickText(cells, idxDist),
            finish: pickText(cells, idxFinish),
            time: pickText(cells, idxTime),
            last3f: pickText(cells, idxLast3f),
        });
    });

    return { runs: runs.length ? runs : null, source };
}

export async function enrichHorsesLast5(horses: Horse[], raceSources: DataSource[], concurrency = 4): Promise<void> {
    const targets = horses.filter(h => !!h.horseUrl);
    let idx = 0;

    const workers = Array.from({ length: concurrency }, async () => {
        while (idx < targets.length) {
            const h = targets[idx++];
            const url = h.horseUrl!;
            try {
                const r = await fetchHorseLast5(url);
                h.last5 = r.runs;
                raceSources.push({ ...r.source, items: [`horse_last5:${h.number}`] });
            } catch (e) {
                h.last5 = null;
                raceSources.push({
                    url,
                    fetchedAtJst: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
                    items: [`horse_last5:${h.number}`],
                    note: '取得失敗',
                });
            }
        }
    });

    await Promise.all(workers);
}
