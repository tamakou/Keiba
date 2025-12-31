import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { Race, Horse, DataSource } from './types';

function nowJstString(): string {
    return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

async function fetchHtml(url: string, encoding: 'UTF-8' | 'EUC-JP' = 'EUC-JP'): Promise<string> {
    const res = await fetch(url, { cache: 'no-store' });
    const buffer = await res.arrayBuffer();
    if (encoding === 'EUC-JP') return iconv.decode(Buffer.from(buffer), 'EUC-JP');
    return new TextDecoder('utf-8').decode(buffer);
}

function parseNullableFloat(s: string): number | null {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
}

function parseNullableInt(s: string): number | null {
    const v = parseInt(s);
    return Number.isFinite(v) ? v : null;
}

export async function getRaceDetails(raceId: string): Promise<Race | null> {
    const url = `https://nar.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
    let html: string;

    try {
        html = await fetchHtml(url, 'EUC-JP');
    } catch (e) {
        console.error('Failed to fetch race:', e);
        return null;
    }

    const $ = cheerio.load(html);

    const sources: DataSource[] = [{
        url,
        fetchedAtJst: nowJstString(),
        items: ['race_meta', 'entries', 'win_place_odds'],
    }];

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
            if (p.includes('m')) course = p || '取得不可';
            if (p.includes('天候')) weather = (p.split(':')[1] || p).trim() || '取得不可';
            if (p.includes('馬場')) baba = (p.split(':')[1] || p).trim() || '取得不可';
        });
    } else {
        sources[0].note = 'RaceData01 が取得できず、基本情報は取得不可扱い';
    }

    const horses: Horse[] = [];

    $('tr').each((_, row) => {
        const $row = $(row);
        const horseLink = $row.find('.HorseName a');
        if (horseLink.length === 0) return;

        const name = horseLink.text().trim() || '取得不可';

        // Gate - null safe
        let gate = parseNullableInt($row.find('td[class^="Waku"]').text().trim());
        if (gate === null) gate = parseNullableInt($row.find('.Waku').text().trim());
        if (gate === null) gate = 0; // Gate 0 means unknown

        // Number - null safe
        let number = parseNullableInt($row.find('td[class^="Umaban"]').text().trim());
        if (number === null) number = parseNullableInt($row.find('.Umaban').text().trim());
        if (number === null) number = 0;

        const jockey = $row.find('.Jockey a').text().trim() || $row.find('.Jockey').text().trim() || '取得不可';
        const trainer = $row.find('.Trainer a').text().trim() || $row.find('.Trainer').text().trim() || '取得不可';

        const weightStr = $row.find('.Weight').text().trim() || '取得不可';
        const weightMatch = weightStr.match(/\(([-+0-9]+)\)/);
        const weightChange = weightMatch ? parseInt(weightMatch[1]) : null;

        // Odds - MUST be null if not available (not 0!)
        let oddsText = $row.find('.Odds').text().trim();
        if (!oddsText) oddsText = $row.find('.Popular').text().trim();
        if (!oddsText) oddsText = $row.find('.Odds_Ninki').text().trim();
        const odds = oddsText ? parseNullableFloat(oddsText) : null;

        const popularityText = $row.find('.Ninki').text().trim();
        const popularity = popularityText ? parseNullableInt(popularityText) : null;

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
            last5: null,  // Not yet implemented
            marketProb: null,
            estimatedProb: 0,
            ev: null,
            factors: [],
        });
    });

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
        sourceUrl: url,
        scrapedAt: nowJstString(),
    };
}

export async function getRaceList(dateStr: string): Promise<{ id: string; name: string; time: string }[]> {
    const baseUrl = `https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=${dateStr}`;
    const html = await fetchHtml(baseUrl, 'UTF-8');
    const $ = cheerio.load(html);

    const races: { id: string; name: string; time: string }[] = [];

    $('a').each((_, link) => {
        const href = $(link).attr('href');
        if (href && href.includes('race_id=')) {
            const match = href.match(/race_id=(\d+)/);
            if (match) {
                const id = match[1];
                const text = $(link).text().trim();
                const timeMatch = text.match(/(\d{1,2}:\d{2})/);
                const timeStr = timeMatch ? timeMatch[1] : '';
                const nameMatch = text.replace(timeStr, '').trim();
                if (!races.find(r => r.id === id)) {
                    races.push({ id, name: nameMatch || id, time: timeStr });
                }
            }
        }
    });

    return races;
}
