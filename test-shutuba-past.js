// test-shutuba-past.js
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

async function test() {
    const raceId = '202536123101';
    const url = `https://nar.netkeiba.com/race/shutuba_past.html?race_id=${raceId}`;

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

    console.log(`Contains Shutuba_Past5_Table: ${html.includes('Shutuba_Past5_Table')}`);
    console.log(`table.Shutuba_Past5_Table count: ${$('table.Shutuba_Past5_Table').length}`);
    console.log(`table.Shutuba_Table count: ${$('table.Shutuba_Table').length}`);
    console.log(`Total tr count: ${$('tr').length}`);
    console.log(`td.Past count: ${$('td.Past').length}`);
    console.log(`td.Umaban count: ${$('td.Umaban').length}`);
    console.log(`.Umaban count: ${$('.Umaban').length}`);

    // Check first few rows
    $('table.Shutuba_Past5_Table tr, table.Shutuba_Table tr').slice(0, 3).each((i, tr) => {
        const $tr = $(tr);
        const umabanText = $tr.find('.Umaban').text().trim();
        const pastCount = $tr.find('td.Past').length;
        const horseName = $tr.find('.Horse_Name a, .HorseName a, dt.Horse02 a').first().text().trim();
        console.log(`Row ${i}: umaban="${umabanText}" pastCells=${pastCount} horse="${horseName}"`);
    });

    // Show a sample of Past cell content
    const firstPast = $('td.Past').first();
    if (firstPast.length) {
        console.log('\nFirst td.Past content:');
        console.log(firstPast.text().trim().substring(0, 200));
    } else {
        console.log('\nNo td.Past found. Checking alternative selectors...');
        // Try other class patterns
        const patterns = ['td[class*="Past"]', 'td[class*="past"]', '.Past', '.RaceData'];
        for (const p of patterns) {
            console.log(`${p}: ${$(p).length}`);
        }
    }
}

test().catch(console.error);
