// src/lib/netkeiba.ts
import * as cheerio from 'cheerio';
import { Race, Horse, DataSource } from './types';
import { fetchHtmlAuto } from './htmlFetch';
import { fetchRaceOddsTables } from './oddsProvider';
import { enrichHorsesLast5 } from './horseHistory';

const BASE = 'https://nar.netkeiba.com';

function absUrl(href: string): string {
    try { return new URL(href, BASE).toString(); } catch { return href; }
}

export async function getRaceList(date: string): Promise<Race[]> {
    const dateListUrl = `${BASE}/top/race_list_get_date_list.html?kaisai_date=${date}&encoding=UTF-8`;
    let dateRes;
    try {
        dateRes = await fetchHtmlAuto(dateListUrl);
    } catch {
        // Fallback to old method
        const listUrl = `${BASE}/top/race_list_sub.html?kaisai_date=${date}`;
        const listRes = await fetchHtmlAuto(listUrl);
        return parseRaceListHtml(listRes.html, listUrl, listRes.fetchedAtJst, date);
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
        ? `${BASE}/top/race_list_sub.html?kaisai_date=${date}&kaisai_id=${kaisaiId}`
        : `${BASE}/top/race_list_sub.html?kaisai_date=${date}`;
    const listRes = await fetchHtmlAuto(listUrl);

    return parseRaceListHtml(listRes.html, listUrl, listRes.fetchedAtJst, date);
}

function parseRaceListHtml(html: string, url: string, fetchedAt: string, date: string): Race[] {
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
                sources: [{ url, fetchedAtJst: fetchedAt, items: ['race_list_sub'] }],
                sourceUrl: url,
                scrapedAt: new Date().toISOString(),
            });
        }
    });

    // Fallback: try looking for links with race_id
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
                            sources: [{ url, fetchedAtJst: fetchedAt, items: ['race_list_sub'] }],
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

export async function getRaceDetails(raceId: string): Promise<Race | null> {
    const sources: DataSource[] = [];

    const shutubaUrl = `${BASE}/race/shutuba.html?race_id=${raceId}`;
    let shutubaRes;
    try {
        shutubaRes = await fetchHtmlAuto(shutubaUrl);
    } catch (e) {
        console.error('Failed to fetch shutuba:', e);
        return null;
    }
    sources.push({ url: shutubaUrl, fetchedAtJst: shutubaRes.fetchedAtJst, items: ['race_meta', 'entries', 'win_odds'] });

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
        const horseUrl = href ? absUrl(href) : null;

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

    // --- OddsProvider ---
    const oddsRes = await fetchRaceOddsTables(raceId);
    sources.push(...oddsRes.sources);

    // 単勝が取れたなら、shutuba側で取れなかった馬だけ補完
    if (oddsRes.tables['単勝']) {
        for (const h of horses) {
            if (h.odds === null) {
                const e = oddsRes.tables['単勝']!.odds[String(h.number)];
                if (e?.value != null) h.odds = e.value;
            }
        }
    }

    // --- 直近5走 ---
    await enrichHorsesLast5(horses, sources);

    // raceIdから日付推定
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
        sourceUrl: shutubaUrl,
        scrapedAt: new Date().toISOString(),
    };
}
