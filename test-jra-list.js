// test-jra-list.js
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

async function test() {
    const date = '20260105';
    const url = `https://race.netkeiba.com/top/race_list.html?kaisai_date=${date}`;

    console.log(`Fetching: ${url}`);

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        },
    });

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    // Try UTF-8 first, fallback to EUC-JP
    let html = buf.toString('utf8');
    if (html.includes('�') || html.match(/charset=EUC-JP/i)) {
        html = iconv.decode(buf, 'EUC-JP');
    }

    console.log(`HTML length: ${html.length}`);

    const $ = cheerio.load(html);

    // Test selectors
    console.log(`\n--- Selector Tests ---`);
    console.log(`li.RaceList_DataItem: ${$('li.RaceList_DataItem').length}`);
    console.log(`.RaceList_DataItem: ${$('.RaceList_DataItem').length}`);
    console.log(`a[href*="race_id"]: ${$('a[href*="race_id"]').length}`);
    console.log(`Total li: ${$('li').length}`);

    // Look for any race_id links
    const raceLinks = [];
    $('a').each((_, a) => {
        const href = $(a).attr('href') || '';
        if (href.includes('race_id=')) {
            const m = href.match(/race_id=(\d+)/);
            if (m) {
                raceLinks.push({
                    id: m[1],
                    text: $(a).text().trim().substring(0, 50)
                });
            }
        }
    });

    console.log(`\n--- Race Links Found: ${raceLinks.length} ---`);
    raceLinks.slice(0, 10).forEach(r => {
        console.log(`  ${r.id}: ${r.text}`);
    });

    // Check if it's JSON or HTML with script
    if (html.includes('var race_list_data')) {
        console.log('\n--- Detected: race_list_data variable (JS rendered) ---');
    }

    // Save sample
    const fs = require('fs');
    fs.writeFileSync('jra_list_sample.html', html);
    console.log('\nSaved jra_list_sample.html');
}

test().catch(console.error);
