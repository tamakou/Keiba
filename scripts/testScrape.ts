
import { fetchHtmlAuto } from '../src/lib/htmlFetch';

async function main() {
    const date = '20241201';
    console.log(`Checking ${date} with full headers...`);

    const url = `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${date}`;

    // Test with fetch directly to control headers completely
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
            'Cache-Control': 'max-age=0',
            'Referer': 'https://race.netkeiba.com/',
            'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        }
    });

    console.log(`Status: ${res.status} ${res.statusText}`);
    const txt = await res.text();
    console.log(`Length: ${txt.length}`);
}

main().catch(console.error);
