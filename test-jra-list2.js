// test-jra-list2.js
async function test() {
    // 試行1: race_list_sub.html
    const subUrl = 'https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=20260105';
    console.log(`Trying: ${subUrl}`);

    try {
        const res = await fetch(subUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });
        const text = await res.text();
        console.log(`Length: ${text.length}`);

        // race_id を探す
        const matches = text.match(/race_id=(\d+)/g) || [];
        console.log(`race_id matches: ${matches.length}`);
        [...new Set(matches)].slice(0, 10).forEach(m => console.log(`  ${m}`));

        // RaceList_DataItem を探す
        const items = (text.match(/RaceList_DataItem/g) || []).length;
        console.log(`RaceList_DataItem occurrences: ${items}`);

        const fs = require('fs');
        fs.writeFileSync('jra_sub.html', text);
        console.log('Saved jra_sub.html');
    } catch (e) {
        console.log(`Error: ${e.message}`);
    }

    // 試行2: kaisai_list のようなものを探す
    // netkeiba.com では開催情報は別のURLパターンかもしれない
    console.log('\n--- 試行2: top_kaisai_info ---');
    try {
        const kUrl = 'https://race.netkeiba.com/top/?kaisai_date=20260105';
        const kRes = await fetch(kUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });
        const kText = await kRes.text();
        console.log(`Length: ${kText.length}`);
        const kMatches = kText.match(/race_id=(\d+)/g) || [];
        console.log(`race_id matches: ${kMatches.length}`);
    } catch (e) {
        console.log(`Error: ${e.message}`);
    }
}

test().catch(console.error);
