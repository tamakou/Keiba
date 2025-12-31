// src/lib/horseHistory.ts
// 5走表示ページ (shutuba_past.html) から全馬の直近5走を一括取得
import * as cheerio from 'cheerio';
import { DataSource, Horse, HorseRun } from './types';
import { fetchHtmlAuto } from './htmlFetch';

const NAR_BASE = 'https://nar.netkeiba.com';

function trimText(text: string | undefined): string | null {
    const v = text?.trim()?.replace(/\s+/g, ' ');
    return v && v.length > 0 ? v : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseOneRun($: cheerio.CheerioAPI, pastCell: any): HorseRun | null {
    // 空セルチェック
    const text = pastCell.text().trim();
    if (!text || text.includes('データがありません')) return null;

    // Data01: 開催日・場所・着順
    // 形式: "2025.12.15 水沢" + Num span で着順
    const data01 = pastCell.find('.Data01');
    const dateVenue = trimText(data01.find('span').first().text());
    const finish = trimText(data01.find('.Num').text());

    // 日付と場所を分離
    let date: string | null = null;
    let venue: string | null = null;
    if (dateVenue) {
        const parts = dateVenue.split(/\s+/);
        if (parts.length >= 1) date = parts[0];
        if (parts.length >= 2) venue = parts[1];
    }

    // Data02: レース名
    const raceName = trimText(pastCell.find('.Data02 a').text()) || trimText(pastCell.find('.Data02').text());

    // Data05: コース・タイム・馬場 (例: "ダ1400 1:30.1 不")
    const data05Text = trimText(pastCell.find('.Data05').text());
    let surfaceDistance: string | null = null;
    let time: string | null = null;
    if (data05Text) {
        const parts = data05Text.split(/\s+/);
        if (parts.length >= 1) surfaceDistance = parts[0]; // ダ1400
        if (parts.length >= 2) time = parts[1]; // 1:30.1
    }

    // Data06: 通過順・上り・馬体重 (例: "2-2-1-1 (40.2) 469(-3)")
    const data06Text = trimText(pastCell.find('.Data06').text());
    let last3f: string | null = null;
    if (data06Text) {
        const last3fMatch = data06Text.match(/\((\d+\.?\d*)\)/);
        if (last3fMatch) last3f = last3fMatch[1];
    }

    // クラス情報がない場合はnull
    const classInfo: string | null = null; // shutuba_pastにはクラス情報がない

    return {
        date,
        venue,
        raceName,
        class: classInfo,
        surfaceDistance,
        finish,
        time,
        last3f,
    };
}

/**
 * shutuba_past.html から全馬の直近5走を取得
 * 馬番をキーとしたMapを返す
 */
export async function fetchAllHorsesLast5FromShutubaPast(
    raceId: string
): Promise<{ horseRunsMap: Map<number, HorseRun[]>; source: DataSource }> {
    const url = `${NAR_BASE}/race/shutuba_past.html?race_id=${raceId}`;
    const res = await fetchHtmlAuto(url);
    const source: DataSource = { url: res.url, fetchedAtJst: res.fetchedAtJst, items: ['shutuba_past'] };

    const $ = cheerio.load(res.html);
    const horseRunsMap = new Map<number, HorseRun[]>();

    // データ行を取得（td.Pastを持つ行のみ）
    let rowIndex = 0;
    $('tr').has('td.Past').each((_, tr) => {
        const $tr = $(tr);
        rowIndex++;

        // 馬番を複数のセレクタで試行
        let umaban = 0;

        // 方法1: td.Txt_C内の.Num (馬番表示セル)
        const numCell = $tr.find('td.Txt_C .Num, .Num').first().text().trim();
        if (numCell) {
            const parsed = parseInt(numCell, 10);
            if (Number.isFinite(parsed) && parsed >= 1) umaban = parsed;
        }

        // 方法2: td.Horse_Info内から馬番抽出
        if (umaban === 0) {
            const horseInfo = $tr.find('td.Horse_Info').text();
            const numMatch = horseInfo.match(/(\d{1,2})番/);
            if (numMatch) umaban = parseInt(numMatch[1], 10);
        }

        // 方法3: 行インデックスをフォールバック
        if (umaban === 0) {
            umaban = rowIndex;
        }

        // 過去戦績セル (td.Past) を収集
        const runs: HorseRun[] = [];
        $tr.find('td.Past').each((_, pastTd) => {
            if (runs.length >= 5) return false;
            const run = parseOneRun($, $(pastTd));
            if (run) runs.push(run);
        });

        if (runs.length > 0) {
            horseRunsMap.set(umaban, runs);
        }
    });

    if (horseRunsMap.size === 0) {
        source.note = '戦績データなし（レース前または構造変更）';
    }

    return { horseRunsMap, source };
}

/**
 * 馬リストに直近5走データを付与
 * shutuba_past.htmlを使用（db.netkeibaではJSレンダリング問題があるため）
 */
export async function enrichHorsesLast5(
    horses: Horse[],
    raceSources: DataSource[],
    raceId: string
): Promise<void> {
    try {
        const { horseRunsMap, source } = await fetchAllHorsesLast5FromShutubaPast(raceId);
        raceSources.push(source);

        for (const h of horses) {
            const runs = horseRunsMap.get(h.number);
            h.last5 = runs ?? null;
        }
    } catch (e) {
        raceSources.push({
            url: `${NAR_BASE}/race/shutuba_past.html?race_id=${raceId}`,
            fetchedAtJst: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
            items: ['shutuba_past'],
            note: '取得失敗',
        });
        // 全馬nullに
        for (const h of horses) {
            h.last5 = null;
        }
    }
}
