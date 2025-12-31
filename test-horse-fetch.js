// test-horse-fetch.js
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

async function test() {
    const url = 'https://db.netkeiba.com/horse/2022102632/';

    console.log(`Fetching: ${url}`);

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; KeibaSim/1.0)',
            'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        },
    });

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    // Charset detection
    const latin1 = buf.toString('latin1');
    const m = latin1.match(/charset=([^\s"'>]+)/i);
    const charset = (m?.[1] ?? '').toUpperCase();

    console.log(`Detected charset: ${charset}`);

    let html;
    if (charset.includes('UTF-8')) {
        html = buf.toString('utf8');
    } else if (charset.includes('EUC-JP') || charset.includes('EUCJP')) {
        html = iconv.decode(buf, 'EUC-JP');
    } else {
        const utf = buf.toString('utf8');
        html = utf.includes('�') ? iconv.decode(buf, 'EUC-JP') : utf;
    }

    console.log(`HTML length: ${html.length}`);

    const $ = cheerio.load(html);

    console.log(`Total tables: ${$('table').length}`);
    console.log(`db_h_race_results found: ${$('table.db_h_race_results').length}`);

    // Check each table
    $('table').each((i, t) => {
        const cls = $(t).attr('class') || 'no-class';
        const firstRowText = $(t).find('tr').first().text().trim().substring(0, 80);
        console.log(`Table ${i}: class="${cls}", first row: "${firstRowText}..."`);
    });

    // Check if 着順 exists in HTML
    console.log(`Contains 着順: ${html.includes('着順')}`);
    console.log(`Contains db_h_race_results: ${html.includes('db_h_race_results')}`);
}

test().catch(console.error);
