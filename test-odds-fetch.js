// test-odds-fetch.js
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

async function test() {
    const raceId = '202536123112'; // 12R
    const type = '三連複';
    const typeCode = 'b7';
    const url = `https://nar.netkeiba.com/odds/index.html?race_id=${raceId}&type=${typeCode}&housiki=c99`;

    console.log(`Fetching: ${url}`);

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; KeibaSim/1.0)',
            'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        },
    });

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    const latin1 = buf.toString('latin1');
    const m = latin1.match(/charset=([^\s"'>]+)/i);
    const charset = (m?.[1] ?? '').toUpperCase();
    console.log(`Detected charset: ${charset}`);

    let html;
    if (charset.includes('EUC-JP') || charset.includes('EUCJP')) {
        html = iconv.decode(buf, 'EUC-JP');
    } else {
        html = buf.toString('utf8');
    }

    console.log(`HTML length: ${html.length}`);

    const $ = cheerio.load(html);

    console.log(`Total tables: ${$('table').length}`);
    console.log(`Odds_List_Table tables: ${$('table.Odds_List_Table').length}`);
    console.log(`Total tr: ${$('tr').length}`);
    console.log(`Total td: ${$('td').length}`);

    // Show first 5 tr contents
    console.log('\n--- First 10 tr contents ---');
    $('tr').slice(0, 10).each((i, tr) => {
        const text = $(tr).text().replace(/\s+/g, ' ').trim().substring(0, 120);
        console.log(`Row ${i}: "${text}"`);
    });

    // Look for combination patterns
    console.log('\n--- Looking for patterns ---');
    const patterns = {
        dash: $('tr').filter((_, tr) => /\d{1,2}\s*[-－–]\s*\d{1,2}\s*[-－–]\s*\d{1,2}/.test($(tr).text())).length,
        arrow: $('tr').filter((_, tr) => /\d{1,2}\s*[→＞>]\s*\d{1,2}/.test($(tr).text())).length,
        decimal: $('tr').filter((_, tr) => /\d+\.\d+/.test($(tr).text())).length,
    };
    console.log(`Rows with dash pattern (1-2-3): ${patterns.dash}`);
    console.log(`Rows with arrow pattern (1>2): ${patterns.arrow}`);
    console.log(`Rows with decimal: ${patterns.decimal}`);

    // Save sample HTML
    const fs = require('fs');
    fs.writeFileSync('sample_odds.html', html);
    console.log('\nSaved sample_odds.html');
}

test().catch(console.error);
