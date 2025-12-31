// src/lib/htmlFetch.ts
import iconv from 'iconv-lite';

export interface FetchHtmlResult {
    url: string;
    html: string;
    fetchedAtJst: string;
}

function nowJstString(): string {
    return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

export async function fetchHtmlAuto(url: string): Promise<FetchHtmlResult> {
    const res = await fetch(url, {
        cache: 'no-store',
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; KeibaSim/1.0)',
            'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        },
    });

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    // まずlatin1でcharsetを抜く
    const latin1 = buf.toString('latin1');
    const m = latin1.match(/charset=([^\s"'>]+)/i);
    const charset = (m?.[1] ?? '').toUpperCase();

    let html: string;
    if (charset.includes('UTF-8')) {
        html = buf.toString('utf8');
    } else if (charset.includes('EUC-JP') || charset.includes('EUCJP')) {
        html = iconv.decode(buf, 'EUC-JP');
    } else {
        // フォールバック：utf8が壊れてそうならEUC-JP
        const utf = buf.toString('utf8');
        html = utf.includes('�') ? iconv.decode(buf, 'EUC-JP') : utf;
    }

    return { url, html, fetchedAtJst: nowJstString() };
}
