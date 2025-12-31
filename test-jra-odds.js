// test-jra-odds.js
async function test() {
    const raceId = '202606010201'; // 中山1R
    const url = `https://race.netkeiba.com/odds/index.html?race_id=${raceId}&type=b1`;

    console.log(`Fetching: ${url}`);

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Language': 'ja-JP,ja;q=0.9',
        },
    });

    console.log(`Status: ${res.status} ${res.statusText}`);

    const text = await res.text();
    console.log(`Length: ${text.length}`);

    // 発売前キーワードをチェック
    const keywords = ['発売前', '発売開始前', '未発売', '準備中', 'データがありません', '確定'];
    for (const kw of keywords) {
        if (text.includes(kw)) {
            console.log(`Found keyword: "${kw}"`);
        }
    }

    // オッズっぽい数字を探す
    const oddsMatches = text.match(/\d+\.\d+/g) || [];
    console.log(`Decimal numbers found: ${oddsMatches.length}`);
    if (oddsMatches.length > 0) {
        console.log(`Sample odds: ${oddsMatches.slice(0, 10).join(', ')}`);
    }

    // tableやtrの数
    const tables = (text.match(/<table/g) || []).length;
    const trs = (text.match(/<tr/g) || []).length;
    console.log(`Tables: ${tables}, TRs: ${trs}`);

    const fs = require('fs');
    fs.writeFileSync('jra_odds_sample.html', text);
    console.log('Saved jra_odds_sample.html');
}

test().catch(console.error);
