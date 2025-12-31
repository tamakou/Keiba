// src/lib/netkeiba.ts
import * as cheerio from 'cheerio';
import { Race, Horse, DataSource, RaceSystem } from './types';
import { fetchHtmlAuto } from './htmlFetch';
import { fetchRaceOddsTables } from './oddsProvider';
import { enrichHorsesLast5 } from './horseHistory';

const NAR_BASE = 'https://nar.netkeiba.com';
const JRA_BASE = 'https://race.netkeiba.com';

function absUrl(base: string, href: string): string {
    try { return new URL(href, base).toString(); } catch { return href; }
}

/** 馬URLをdb.netkeiba.comに正規化（nar.のままだと404） */
function normalizeHorseUrl(href: string): string | null {
    if (!href) return null;
    if (href.includes('db.netkeiba.com')) return href;
    const m = href.match(/\/horse\/([0-9a-zA-Z]+)/);
    if (m) return `https://db.netkeiba.com/horse/${m[1]}/`;
    return href;
}

// ============================================================================
// NAR Implementation (既存ロジック)
// ============================================================================

async function getRaceListNar(date: string): Promise<Race[]> {
    const dateListUrl = `${NAR_BASE}/top/race_list_get_date_list.html?kaisai_date=${date}&encoding=UTF-8`;
    let dateRes;
    try {
        dateRes = await fetchHtmlAuto(dateListUrl);
    } catch {
        const listUrl = `${NAR_BASE}/top/race_list_sub.html?kaisai_date=${date}`;
        const listRes = await fetchHtmlAuto(listUrl);
        return parseRaceListHtmlNar(listRes.html, listUrl, listRes.fetchedAtJst, date);
    }

    const $date = cheerio.load(dateRes.html);
    let kaisaiId = '';
    $date('li').each((_, el) => {
        const d = $date(el).attr('date');
        if (d === date) {
            const href = $date(el).find('a').attr('href') || '';
            const match = href.match(/kaisai_id=(\d+)/);
            if (match) kaisaiId = match[1];
        }
    });

    const listUrl = kaisaiId
        ? `${NAR_BASE}/top/race_list_sub.html?kaisai_date=${date}&kaisai_id=${kaisaiId}`
        : `${NAR_BASE}/top/race_list_sub.html?kaisai_date=${date}`;
    const listRes = await fetchHtmlAuto(listUrl);

    return parseRaceListHtmlNar(listRes.html, listUrl, listRes.fetchedAtJst, date);
}

function parseRaceListHtmlNar(html: string, url: string, fetchedAt: string, date: string): Race[] {
    const $ = cheerio.load(html);
    const races: Race[] = [];

    $('.RaceList_DataItem').each((_, el) => {
        const $el = $(el);
        const idHref = $el.find('a').attr('href') || '';
        const idMatch = idHref.match(/race_id=(\d+)/);
        const id = idMatch ? idMatch[1] : '';

        const raceNum = $el.find('.Race_Num span').first().text().replace('R', '').trim();
        const name = $el.find('.RaceList_ItemTitle .ItemTitle').text().trim();
        const time = $el.find('.RaceData span').first().text().trim() || '取得不可';
        const course = $el.find('.RaceData .Dart, .RaceData .Turf').text().trim() || '取得不可';

        if (id) {
            races.push({
                id,
                name: `${raceNum}R ${name}`,
                date,
                time,
                course,
                weather: '取得不可',
                baba: '取得不可',
                horses: [],
                sources: [{ url, fetchedAtJst: fetchedAt, items: ['nar_race_list'] }],
                system: 'NAR',
                sourceUrl: url,
                scrapedAt: new Date().toISOString(),
            });
        }
    });

    // Fallback
    if (races.length === 0) {
        $('a').each((_, link) => {
            const href = $(link).attr('href') || '';
            if (href.includes('race_id=')) {
                const match = href.match(/race_id=(\d+)/);
                if (match) {
                    const id = match[1];
                    const text = $(link).text().trim();
                    const timeMatch = text.match(/(\d{1,2}:\d{2})/);
                    const timeStr = timeMatch ? timeMatch[1] : '取得不可';
                    const nameMatch = text.replace(timeStr, '').trim();
                    if (!races.find(r => r.id === id)) {
                        races.push({
                            id,
                            name: nameMatch || id,
                            date,
                            time: timeStr,
                            course: '取得不可',
                            weather: '取得不可',
                            baba: '取得不可',
                            horses: [],
                            sources: [{ url, fetchedAtJst: fetchedAt, items: ['nar_race_list'] }],
                            system: 'NAR',
                            sourceUrl: url,
                            scrapedAt: new Date().toISOString(),
                        });
                    }
                }
            }
        });
    }

    return races;
}

async function getRaceDetailsNar(raceId: string): Promise<Race | null> {
    const sources: DataSource[] = [];

    const shutubaUrl = `${NAR_BASE}/race/shutuba.html?race_id=${raceId}`;
    let shutubaRes;
    try {
        shutubaRes = await fetchHtmlAuto(shutubaUrl);
    } catch (e) {
        console.error('Failed to fetch NAR shutuba:', e);
        return null;
    }
    sources.push({ url: shutubaUrl, fetchedAtJst: shutubaRes.fetchedAtJst, items: ['nar_shutuba', 'entries', 'win_odds'] });

    const $ = cheerio.load(shutubaRes.html);

    const raceName = $('.RaceName').text().trim() || '取得不可';
    const metaText = $('.RaceData01').text().trim();

    let weather = '取得不可';
    let baba = '取得不可';
    let time = '取得不可';
    let course = '取得不可';

    if (metaText) {
        const parts = metaText.split('/').map(s => s.trim());
        parts.forEach(p => {
            if (p.includes('発走')) time = p.replace('発走', '').trim() || '取得不可';
            if (p.includes('m')) course = p.trim() || '取得不可';
            if (p.includes('天候')) weather = (p.split(':')[1] || p).trim() || '取得不可';
            if (p.includes('馬場')) baba = (p.split(':')[1] || p).trim() || '取得不可';
        });
    }

    const horses: Horse[] = [];
    $('tr').each((_, row) => {
        const $row = $(row);
        const horseLink = $row.find('.HorseName a');
        if (!horseLink.length) return;

        const name = horseLink.text().trim() || '取得不可';
        const href = horseLink.attr('href') || '';
        const horseUrl = normalizeHorseUrl(href);

        let gate = 0;
        const wakuText = $row.find('td[class^="Waku"]').text().trim();
        if (wakuText) gate = parseInt(wakuText, 10);
        else gate = parseInt($row.find('.Waku').text().trim(), 10) || 0;

        let number = 0;
        const umabanText = $row.find('td[class^="Umaban"]').text().trim();
        if (umabanText) number = parseInt(umabanText, 10);
        else number = parseInt($row.find('.Umaban').text().trim(), 10) || 0;

        const jockey = $row.find('.Jockey a').text().trim() || $row.find('.Jockey').text().trim() || '取得不可';
        const trainer = $row.find('.Trainer a').text().trim() || $row.find('.Trainer').text().trim() || '取得不可';

        const weightStr = $row.find('.Weight').text().trim() || '取得不可';
        const weightMatch = weightStr.match(/\(([-+0-9]+)\)/);
        const weightChange = weightMatch ? parseInt(weightMatch[1], 10) : null;

        let oddsText = $row.find('.Odds').text().trim();
        if (!oddsText) oddsText = $row.find('.Popular').text().trim();
        if (!oddsText) oddsText = $row.find('.Odds_Ninki').text().trim();
        const odds = oddsText ? (Number.isFinite(parseFloat(oddsText)) ? parseFloat(oddsText) : null) : null;

        const popText = $row.find('.Ninki').text().trim();
        const popularity = popText ? (parseInt(popText, 10) || null) : null;

        horses.push({
            gate,
            number,
            name,
            jockey,
            trainer,
            weight: weightStr,
            weightChange,
            odds,
            popularity,
            horseUrl,
            last5: null,
            marketProb: null,
            estimatedProb: 0,
            ev: null,
            factors: [],
        });
    });

    // NAR Odds
    const oddsRes = await fetchRaceOddsTables(raceId, 'NAR');
    sources.push(...oddsRes.sources);

    if (oddsRes.tables['単勝']) {
        for (const h of horses) {
            if (h.odds === null) {
                const e = oddsRes.tables['単勝']!.odds[String(h.number)];
                if (e?.value != null) h.odds = e.value;
            }
        }
    }

    // 直近5走
    await enrichHorsesLast5(horses, sources, raceId, 'NAR');

    let date = '';
    if (raceId && raceId.length >= 10) {
        const y = raceId.substring(0, 4);
        const md = raceId.substring(6, 10);
        date = `${y}${md}`;
    }

    return {
        id: raceId,
        name: raceName,
        date,
        time,
        course,
        weather,
        baba,
        horses,
        sources,
        oddsTables: oddsRes.tables,
        system: 'NAR',
        sourceUrl: shutubaUrl,
        scrapedAt: new Date().toISOString(),
    };
}

// ============================================================================
// JRA Implementation (新規)
// ============================================================================

async function getRaceListJra(date: string): Promise<Race[]> {
    // race_list_sub.html はJSレンダリング不要で取得可能
    const url = `${JRA_BASE}/top/race_list_sub.html?kaisai_date=${date}`;
    let res;
    try {
        res = await fetchHtmlAuto(url);
    } catch (e) {
        console.error('Failed to fetch JRA race list:', e);
        return [];
    }
    const sources: DataSource[] = [{ url: res.url, fetchedAtJst: res.fetchedAtJst, items: ['jra_race_list'] }];

    const $ = cheerio.load(res.html);
    const races: Race[] = [];

    // JRAのレースリスト構造をパース
    $('.RaceList_DataItem, .RaceList_DataItem01, .RaceList_DataItem02, li[class*="RaceList"]').each((_, el) => {
        const $el = $(el);
        const href = $el.find('a').attr('href') || '';
        const m = href.match(/race_id=(\d+)/);
        const id = m ? m[1] : '';
        if (!id) return;

        const raceNum = $el.find('.Race_Num span').first().text().replace('R', '').trim() ||
            $el.find('.RaceNum').text().replace('R', '').trim();
        const name = $el.find('.RaceList_ItemTitle .ItemTitle').text().trim() ||
            $el.find('.RaceName').text().trim() ||
            $el.find('.ItemTitle').text().trim();
        const time = $el.find('.RaceData span').first().text().trim() || '取得不可';
        const course = $el.find('.RaceData').text().trim().replace(/\s+/g, ' ') || '取得不可';

        races.push({
            id,
            name: `${raceNum ? raceNum + 'R ' : ''}${name || ''}`.trim() || '取得不可',
            date,
            time,
            course,
            weather: '取得不可',
            baba: '取得不可',
            horses: [],
            sources,
            system: 'JRA',
            sourceUrl: res.url,
            scrapedAt: new Date().toISOString(),
        });
    });

    // Fallback: race_idを含むリンクを探す
    if (races.length === 0) {
        $('a[href*="race_id="]').each((_, link) => {
            const href = $(link).attr('href') || '';
            const match = href.match(/race_id=(\d+)/);
            if (match) {
                const id = match[1];
                const text = $(link).text().trim();
                if (!races.find(r => r.id === id)) {
                    races.push({
                        id,
                        name: text || id,
                        date,
                        time: '取得不可',
                        course: '取得不可',
                        weather: '取得不可',
                        baba: '取得不可',
                        horses: [],
                        sources: [{ url: res.url, fetchedAtJst: res.fetchedAtJst, items: ['jra_race_list'], note: 'フォールバック抽出' }],
                        system: 'JRA',
                        sourceUrl: res.url,
                        scrapedAt: new Date().toISOString(),
                    });
                }
            }
        });
    }

    if (races.length === 0) {
        sources[0].note = 'JRA race_listからレースが取れません（HTML構造変更の可能性）';
    }

    return races;
}

async function getRaceDetailsJra(raceId: string): Promise<Race | null> {
    const shutubaUrl = `${JRA_BASE}/race/shutuba.html?race_id=${raceId}`;
    let res;
    try {
        res = await fetchHtmlAuto(shutubaUrl);
    } catch (e) {
        console.error('Failed to fetch JRA shutuba:', e);
        return null;
    }
    const sources: DataSource[] = [{ url: res.url, fetchedAtJst: res.fetchedAtJst, items: ['jra_shutuba'] }];

    const $ = cheerio.load(res.html);

    const raceName = $('.RaceName').text().trim() || '取得不可';
    const metaText = $('.RaceData01').text().trim();

    let weather = '取得不可';
    let baba = '取得不可';
    let time = '取得不可';
    let course = '取得不可';

    if (metaText) {
        const parts = metaText.split('/').map(s => s.trim());
        parts.forEach(p => {
            if (p.includes('発走')) time = p.replace('発走', '').trim() || '取得不可';
            if (p.includes('m')) course = p.trim() || '取得不可';
            if (p.includes('天候')) weather = (p.split(':')[1] || p).trim() || '取得不可';
            if (p.includes('馬場')) baba = (p.split(':')[1] || p).trim() || '取得不可';
        });
    }

    const horses: Horse[] = [];
    $('tr').each((_, row) => {
        const $row = $(row);

        // 馬名リンクを探す
        const horseLink =
            $row.find('.HorseName a').first().length ? $row.find('.HorseName a').first() :
                $row.find('.Horse_Name a').first().length ? $row.find('.Horse_Name a').first() :
                    $row.find('a[href*="/horse/"]').first();

        if (!horseLink.length) return;

        const name = horseLink.text().trim() || '取得不可';
        const href = horseLink.attr('href') || '';
        const horseUrl = normalizeHorseUrl(href);

        const wakuText = $row.find('td[class^="Waku"]').text().trim() || $row.find('.Waku').text().trim();
        const umabanText = $row.find('td[class^="Umaban"]').text().trim() || $row.find('.Umaban').text().trim();

        const gate = parseInt(wakuText, 10) || 0;
        const number = parseInt(umabanText, 10) || 0;

        const jockey =
            $row.find('.Jockey a').text().trim() ||
            $row.find('.Jockey').text().trim() ||
            '取得不可';

        const trainer =
            $row.find('.Trainer a').text().trim() ||
            $row.find('.Trainer').text().trim() ||
            $row.find('td.Trainer').text().trim() ||
            '取得不可';

        const weightStr = $row.find('.Weight').text().trim() || '取得不可';
        const weightMatch = weightStr.match(/\(([-+0-9]+)\)/);
        const weightChange = weightMatch ? parseInt(weightMatch[1], 10) : null;

        const oddsText =
            $row.find('.Odds').text().trim() ||
            $row.find('.Odds_Ninki').text().trim() ||
            '';
        const odds = oddsText ? (Number.isFinite(parseFloat(oddsText)) ? parseFloat(oddsText) : null) : null;

        const popText = $row.find('.Ninki').text().trim();
        const popularity = popText ? (parseInt(popText, 10) || null) : null;

        horses.push({
            gate,
            number,
            name,
            jockey,
            trainer,
            weight: weightStr,
            weightChange,
            odds,
            popularity,
            horseUrl,
            last5: null,
            marketProb: null,
            estimatedProb: 0,
            ev: null,
            factors: [],
        });
    });

    // JRA Odds
    const oddsRes = await fetchRaceOddsTables(raceId, 'JRA');
    sources.push(...oddsRes.sources);

    if (oddsRes.tables['単勝']) {
        for (const h of horses) {
            if (h.odds === null) {
                const e = oddsRes.tables['単勝']!.odds[String(h.number)];
                if (e?.value != null) h.odds = e.value;
            }
        }
    }

    // 直近5走
    await enrichHorsesLast5(horses, sources, raceId, 'JRA');

    let date = '';
    if (raceId && raceId.length >= 10) {
        const y = raceId.substring(0, 4);
        const md = raceId.substring(6, 10);
        date = `${y}${md}`;
    }

    return {
        id: raceId,
        name: raceName,
        date,
        time,
        course,
        weather,
        baba,
        horses,
        sources,
        oddsTables: oddsRes.tables,
        system: 'JRA',
        sourceUrl: shutubaUrl,
        scrapedAt: new Date().toISOString(),
    };
}

// ============================================================================
// Public API (統合)
// ============================================================================

export async function getRaceList(date: string): Promise<Race[]> {
    // NAR + JRA を両方返す（片方失敗しても片方は返す）
    const [nar, jra] = await Promise.allSettled([getRaceListNar(date), getRaceListJra(date)]);
    const out: Race[] = [];

    if (nar.status === 'fulfilled') out.push(...nar.value);
    if (jra.status === 'fulfilled') out.push(...jra.value);

    return out;
}

export async function getRaceDetails(raceId: string, system: RaceSystem = 'NAR'): Promise<Race | null> {
    return system === 'JRA' ? getRaceDetailsJra(raceId) : getRaceDetailsNar(raceId);
}
