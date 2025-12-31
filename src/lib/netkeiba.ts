import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { Race, Horse } from './types';

// Helper to fetch and decode (handles EUC-JP if needed, though NAR pages vary)
async function fetchHtml(url: string, encoding: 'UTF-8' | 'EUC-JP' = 'EUC-JP'): Promise<string> {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();

    if (encoding === 'EUC-JP') {
        return iconv.decode(Buffer.from(buffer), 'EUC-JP');
    }
    return new TextDecoder('utf-8').decode(buffer);
}

export async function getRaceList(date: string): Promise<Race[]> {
    // 1. Get Date and ID param from date list page (optional, but good for ID)
    // Actually we can just hit the sub page directly if we form the URL right?
    // But we need the 'kaisai_id'.
    // Let's scrape the date list first to find the active ID for the date.
    const dateListUrl = `https://nar.netkeiba.com/top/race_list_get_date_list.html?kaisai_date=${date}&encoding=UTF-8`;
    const dateHtml = await fetchHtml(dateListUrl, 'UTF-8');
    const $date = cheerio.load(dateHtml);

    // Find the active tab or the tab matching the date
    // The tab links are like: race_list_sub.html?kaisai_date=20251231&kaisai_id=2025361231
    let kaisaiId = '';
    $date('li').each((_, el) => {
        const d = $date(el).attr('date');
        if (d === date) {
            const href = $date(el).find('a').attr('href') || '';
            const match = href.match(/kaisai_id=(\d+)/);
            if (match) kaisaiId = match[1];
        }
    });

    if (!kaisaiId) return []; // No race found for this date

    // 2. Fetch the sub list
    const listUrl = `https://nar.netkeiba.com/top/race_list_sub.html?kaisai_date=${date}&kaisai_id=${kaisaiId}`;
    const listHtml = await fetchHtml(listUrl, 'UTF-8'); // This is usually UTF-8 return from AJAX
    const $ = cheerio.load(listHtml);

    const races: Race[] = [];

    // Iterate over race items
    $('.RaceList_DataItem').each((_, el) => {
        const $el = $(el);
        const idHref = $el.find('a').attr('href') || '';
        const idMatch = idHref.match(/race_id=(\d+)/);
        const id = idMatch ? idMatch[1] : '';

        const raceNum = $el.find('.Race_Num span').first().text().replace('R', '').trim();
        const name = $el.find('.RaceList_ItemTitle .ItemTitle').text().trim();
        const time = $el.find('.RaceData span').first().text().trim();
        const course = $el.find('.RaceData .Dart, .RaceData .Turf').text().trim();

        // Additional info? Weather? Not in list usually, inside details.

        if (id) {
            races.push({
                id,
                name: `${raceNum}R ${name}`,
                date,
                time,
                course,
                weather: '',
                baba: '',
                horses: [],
            });
        }
    });

    return races;
}

export async function getRaceDetails(raceId: string): Promise<Race | null> {
    const url = `https://nar.netkeiba.com/race/shutuba.html?race_id=${raceId}`;
    const html = await fetchHtml(url, 'EUC-JP');
    const $ = cheerio.load(html);

    // Parse Metadata
    const raceName = $('.RaceName').text().trim(); // Might include "10R" etc
    const metaText = $('.RaceData01').text().trim(); // "16:30発走 / ダ1600m (右) / 天候:晴 / 馬場:良"

    // Extract Metadata
    let weather = '取得不可';
    let baba = '取得不可';
    let time = '';
    let course = '';

    // Parse metaText (Example: "16:30発走 / ダ1600m (右) / 天候:晴 / 馬場:良")
    const parts = metaText.split('/').map(s => s.trim());
    parts.forEach(p => {
        if (p.includes('発走')) time = p.replace('発走', '');
        if (p.includes('m')) course = p;
        if (p.includes('天候')) weather = p.split(':')[1] || p;
        if (p.includes('馬場')) baba = p.split(':')[1] || p;
    });

    const horses: Horse[] = [];

    // Parse Horse Table
    // Main table usually has ID #shutuba_table or class .Shutuba_Table
    // If not found, look for tr with class .HorseList
    // const rows = $('.RaceTable01 tr.HorseList, table#shutuba_table tr.HorseList'); // Generic guess

    // Fallback if specific classes aren't consistent, try selector on tr that has data
    // Use rows loop
    $('tr').each((i, row) => {
        // Check if it's a horse row (has horse name link)
        const $row = $(row);
        const horseLink = $row.find('.HorseName a');
        if (horseLink.length === 0) return;

        const name = horseLink.text().trim();
        // NAR Selectors often use WakuN, UmabanN classes on the TD itself
        // Try multiple patterns
        let gate = 0;
        const wakuText = $row.find('td[class^="Waku"]').text().trim();
        if (wakuText) gate = parseInt(wakuText);
        else gate = parseInt($row.find('.Waku').text().trim()) || 0;

        let number = 0;
        const umabanText = $row.find('td[class^="Umaban"]').text().trim();
        if (umabanText) number = parseInt(umabanText);
        else number = parseInt($row.find('.Umaban').text().trim()) || 0;

        const jockey = $row.find('.Jockey a').text().trim() || $row.find('.Jockey').text().trim();
        const trainer = $row.find('.Trainer a').text().trim() || $row.find('.Trainer').text().trim();

        const weightStr = $row.find('.Weight').text().trim(); // "468(+2)"
        let weightChange = 0;
        const weightMatch = weightStr.match(/\(([-+0-9]+)\)/);
        if (weightMatch) {
            weightChange = parseInt(weightMatch[1]);
        }

        // Odds: NAR might use .Popular or .Odds_Ninki
        let oddsText = $row.find('.Odds').text().trim();
        if (!oddsText) oddsText = $row.find('.Popular').text().trim(); // Agent found odds here?
        if (!oddsText) oddsText = $row.find('.Odds_Ninki').text().trim();

        // Clean odds text (remove non-numeric if needed, though parseFloat handles it)
        const odds = parseFloat(oddsText) || 0;

        // Popularity (Ninken) - If .Popular holds odds, where is rank?
        // Usually NAR has a separate column. Let's assume .Ninki if existing, or fallback.
        // For now, if .Popular is odds, popularity might be lost or in another col.
        // We'll trust the parser to find *something* numeric or just 0.
        const popularity = parseInt($row.find('.Ninki').text().trim()) || 0;

        const last5: string[] = [];

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
            last5,
            marketProb: 0,
            estimatedProb: 0,
            ev: 0,
            factors: []
        });
    });

    // If scraping failed (empty horses), unexpected HTML structure.
    if (horses.length === 0) {
        // Log or handle? Return partial?
    }

    // Race ID format (e.g. 202544123110 -> Year(4) Place(2) MMDD(4) RR(2))?
    // Let's assume standard assumption: 
    // Actually, looking at race_list_sub links: race_id=2025361231...
    // We can extract YYYYMMDD if we parse the ID carefully.
    // Length 12: YYYY(4) Place(2) MMDD(4) RR(2)
    // Example: 2025 36 1231 01
    // Example: 2025 36 1231 01
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
        sourceUrl: url,
        scrapedAt: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    };
}
