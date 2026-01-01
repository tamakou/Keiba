import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

import { getRaceDetails } from '../src/lib/netkeiba';
import { computeModelV2 } from '../src/lib/modelV2';
import { fetchHtmlAuto } from '../src/lib/htmlFetch';
import { getModelWeights } from '../src/lib/modelWeights';

type System = 'JRA' | 'NAR';
type RaceSpec = { raceId: string; system: System };

function arg(name: string, def?: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return def;
}

function softmax3(a: number, b: number, c: number): [number, number, number] {
    const ea = Math.exp(a), eb = Math.exp(b), ec = Math.exp(c);
    const s = ea + eb + ec;
    return [ea / s, eb / s, ec / s];
}

async function fetchResultTop3(raceId: string, system: System): Promise<number[] | null> {
    const base = system === 'JRA' ? 'https://race.netkeiba.com' : 'https://nar.netkeiba.com';
    const url = `${base}/race/result.html?race_id=${raceId}`;
    const res = await fetchHtmlAuto(url);
    const $ = cheerio.load(res.html);

    // 候補テーブルを広めに探索
    const tables = [
        'table.RaceTable01',
        'table.Result_Table',
        'table#All_Result_Table',
        'table',
    ];

    let bestRows: any[] = [];
    for (const sel of tables) {
        const rows = $(sel).find('tr').toArray();
        if (rows.length > bestRows.length) bestRows = rows;
    }

    const found: { rank: number; umaban: number }[] = [];

    for (const tr of bestRows) {
        const $tr = $(tr);
        const rankText =
            $tr.find('td.Rank').text().trim() ||
            $tr.find('td').first().text().trim();
        const r = parseInt(rankText, 10);
        if (!Number.isFinite(r) || r < 1 || r > 3) continue;

        const umabanText =
            $tr.find('td.Umaban').text().trim() ||
            $tr.find('.Umaban').text().trim() ||
            $tr.find('td.Num').text().trim();
        const u = parseInt(umabanText, 10);
        if (!Number.isFinite(u) || u <= 0) continue;

        found.push({ rank: r, umaban: u });
    }

    if (found.length === 0) return null;
    found.sort((a, b) => a.rank - b.rank);
    return found.map(x => x.umaban).slice(0, 3);
}

function brier(probs: Map<number, number>, winner: number): number {
    let s = 0;
    for (const [num, p] of probs.entries()) {
        const y = (num === winner) ? 1 : 0;
        s += (p - y) * (p - y);
    }
    return s;
}

async function predictWinProbs(raceId: string, system: System): Promise<{ probs: Map<number, number>; top3: number[]; note: string }> {
    const race = await getRaceDetails(raceId, system);
    if (!race) throw new Error(`Race not found: ${raceId} (${system})`);

    // 重みはファイルからロード（最適化の成果が反映される）
    const _w = getModelWeights();

    // 外部統計は backtest ではデフォルトOFF推奨（負荷対策）
    const v2 = computeModelV2(race, {});

    // 3ペースシナリオ（winner確率だけなら線形合成でOK）
    const useMixture = (process.env.KEIBA_BACKTEST_USE_PACE_MIXTURE ?? '1') === '1';
    let win = v2.probs;
    let note = `pace=${v2.paceIndex.toFixed(2)}`;

    if (useMixture) {
        const pace = v2.paceIndex;
        const paceShift = Number(process.env.KEIBA_PACE_SHIFT || '') || 0.6;
        const scale = Number(process.env.KEIBA_PACE_SOFTMAX_SCALE || '') || 1.2;
        const normalBias = Number(process.env.KEIBA_PACE_NORMAL_BIAS || '') || 0.8;
        const [pSlow, pNormal, pFast] = softmax3(-scale * pace, normalBias, +scale * pace);

        const slow = computeModelV2(race, { paceOverride: Math.max(-1, pace - paceShift) });
        const fast = computeModelV2(race, { paceOverride: Math.min(+1, pace + paceShift) });

        win = win.map((_, i) => pSlow * slow.probs[i] + pNormal * v2.probs[i] + pFast * fast.probs[i]);
        note = `paceMix pSlow=${pSlow.toFixed(2)} pN=${pNormal.toFixed(2)} pF=${pFast.toFixed(2)} basePace=${pace.toFixed(2)}`;
    }

    const probs = new Map<number, number>();
    race.horses.forEach((h, i) => probs.set(h.number, win[i]));

    const top3 = [...probs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
    return { probs, top3, note };
}

async function main() {
    const file = arg('--data', path.join('data', 'backtest_races.json'))!;
    const json = JSON.parse(fs.readFileSync(file, 'utf-8')) as RaceSpec[];
    if (!Array.isArray(json) || json.length === 0) {
        console.log(`No races in ${file}. Fill it with past race ids first.`);
        process.exit(0);
    }

    let n = 0;
    let ll = 0;
    let br = 0;
    let top1 = 0;
    let top3hit = 0;

    for (const r of json) {
        try {
            const top = await fetchResultTop3(r.raceId, r.system);
            if (!top || top.length === 0) {
                console.log(`[SKIP] result parse failed ${r.system} ${r.raceId}`);
                continue;
            }
            const winner = top[0];

            const pred = await predictWinProbs(r.raceId, r.system);
            const p = pred.probs.get(winner) ?? 1e-12;
            const pSafe = Math.max(1e-12, Math.min(1, p));

            ll += -Math.log(pSafe);
            br += brier(pred.probs, winner);
            n += 1;

            const best = [...pred.probs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            if (best === winner) top1 += 1;
            if (pred.top3.includes(winner)) top3hit += 1;

            console.log(`[OK] ${r.system} ${r.raceId} win=${winner} p=${pSafe.toFixed(4)} top3Pred=${pred.top3.join(',')} note=${pred.note}`);
        } catch (e) {
            console.log(`[ERROR] ${r.system} ${r.raceId}: ${e}`);
        }
    }

    if (n === 0) {
        console.log('No evaluated races.');
        process.exit(0);
    }

    console.log('--- Summary ---');
    console.log(`N=${n}`);
    console.log(`LogLoss=${(ll / n).toFixed(6)}`);
    console.log(`Brier=${(br / n).toFixed(6)}`);
    console.log(`Top1Acc=${(top1 / n).toFixed(3)}`);
    console.log(`Top3Hit(winner in top3)=${(top3hit / n).toFixed(3)}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
