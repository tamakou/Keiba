// test-shutuba-past2.js
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

    const $ = cheerio.load(html);

    // Look for various potential horse number selectors
    const selectors = [
        'td.Num',
        '.Num',
        'td[class*="Num"]',
        '.Txt_C',
        'td:first-child',
        '.Horse_Num',
        'span.Num',
        '.Waku_Num',
        'td.Txt_C span'
    ];

    for (const s of selectors) {
        const count = $(s).length;
        if (count > 0) {
            const sample = $(s).slice(0, 3).map((_, el) => $(el).text().trim()).get().join(' | ');
            console.log(`${s}: ${count} items, samples: "${sample}"`);
        }
    }

    // Check the first TR that has td.Past
    console.log('\n--- Checking rows with td.Past ---');
    $('tr').has('td.Past').slice(0, 2).each((i, tr) => {
        const $tr = $(tr);
        // Look at all td in the row
        const tds = $tr.find('td').map((_, td) => {
            const cls = $(td).attr('class') || 'no-class';
            const txt = $(td).text().trim().substring(0, 30);
            return `[${cls}]: "${txt}"`;
        }).get();
        console.log(`Row ${i}: ${tds.length} cells`);
        tds.slice(0, 5).forEach(td => console.log(`  ${td}`));
    });
}

test().catch(console.error);
