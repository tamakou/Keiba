import fs from 'fs';
import path from 'path';

import { getModelWeights, saveModelWeightsToFile, ModelWeights } from '../src/lib/modelWeights';
import { computeModelV2 } from '../src/lib/modelV2';
import { getRaceDetails } from '../src/lib/netkeiba';
import { fetchHtmlAuto } from '../src/lib/htmlFetch';
import * as cheerio from 'cheerio';

type System = 'JRA' | 'NAR';
type RaceSpec = { raceId: string; system: System };

function arg(name: string, def?: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return def;
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}

function randn(): number {
    // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function softmax3(a: number, b: number, c: number): [number, number, number] {
    const ea = Math.exp(a), eb = Math.exp(b), ec = Math.exp(c);
    const s = ea + eb + ec;
    return [ea / s, eb / s, ec / s];
}

async function fetchWinner(raceId: string, system: System): Promise<number | null> {
    const base = system === 'JRA' ? 'https://race.netkeiba.com' : 'https://nar.netkeiba.com';
    const url = `${base}/race/result.html?race_id=${raceId}`;
    const res = await fetchHtmlAuto(url);
    const $ = cheerio.load(res.html);

    const rows = $('table.RaceTable01 tr, table.Result_Table tr, tr').toArray();
    for (const tr of rows) {
        const $tr = $(tr);
        const rankText = $tr.find('td.Rank').text().trim() || $tr.find('td').first().text().trim();
        const r = parseInt(rankText, 10);
        if (!Number.isFinite(r) || r !== 1) continue;
        const umabanText =
            $tr.find('td.Umaban').text().trim() ||
            $tr.find('.Umaban').text().trim() ||
            $tr.find('td.Num').text().trim();
        const u = parseInt(umabanText, 10);
        if (Number.isFinite(u) && u > 0) return u;
    }
    return null;
}

async function evalWeightsOnSet(races: RaceSpec[], weights: Partial<ModelWeights>): Promise<number> {
    // objective: mean logloss on winner
    let n = 0;
    let ll = 0;

    for (const r of races) {
        try {
            const race = await getRaceDetails(r.raceId, r.system);
            if (!race) continue;
            const winner = await fetchWinner(r.raceId, r.system);
            if (!winner) continue;

            const v2 = computeModelV2(race, { weightsOverride: weights });

            // pace mixture (winner prob only: linear mix of scenario win probs)
            const useMixture = (process.env.KEIBA_BACKTEST_USE_PACE_MIXTURE ?? '1') === '1';
            let win = v2.probs;

            if (useMixture) {
                const pace = v2.paceIndex;
                const paceShift = Number(process.env.KEIBA_PACE_SHIFT || '') || 0.6;
                const scale = Number(process.env.KEIBA_PACE_SOFTMAX_SCALE || '') || 1.2;
                const normalBias = Number(process.env.KEIBA_PACE_NORMAL_BIAS || '') || 0.8;
                const [pSlow, pNormal, pFast] = softmax3(-scale * pace, normalBias, +scale * pace);

                const slow = computeModelV2(race, { weightsOverride: weights, paceOverride: Math.max(-1, pace - paceShift) });
                const fast = computeModelV2(race, { weightsOverride: weights, paceOverride: Math.min(+1, pace + paceShift) });

                win = win.map((_, i) => pSlow * slow.probs[i] + pNormal * v2.probs[i] + pFast * fast.probs[i]);
            }

            const idx = race.horses.findIndex(h => h.number === winner);
            if (idx < 0) continue;
            const p = clamp(win[idx], 1e-12, 1);
            ll += -Math.log(p);
            n += 1;
        } catch {
            // skip errors
        }
    }

    return n > 0 ? (ll / n) : Number.POSITIVE_INFINITY;
}

function mutate(base: ModelWeights, sigma: number): ModelWeights {
    const w: ModelWeights = { ...base };

    // 係数は正であるべきなので log-space っぽく揺らす
    const mult = (x: number) => clamp(x * (1 + randn() * sigma), 0.0001, 3.0);

    w.form = mult(w.form);
    w.last3f = mult(w.last3f);
    w.dist = mult(w.dist);
    w.going = mult(w.going);
    w.styleScale = clamp(w.styleScale * (1 + randn() * sigma), 0.2, 3.0);
    w.jockey = clamp(w.jockey * (1 + randn() * sigma), 0.0, 0.3);
    w.trainer = clamp(w.trainer * (1 + randn() * sigma), 0.0, 0.3);
    w.insideBiasScale = clamp(w.insideBiasScale * (1 + randn() * sigma), 0.2, 3.0);
    w.frontBiasScale = clamp(w.frontBiasScale * (1 + randn() * sigma), 0.2, 3.0);
    w.paceScale = clamp(w.paceScale * (1 + randn() * sigma), 0.2, 3.0);

    return w;
}

async function main() {
    const file = arg('--data', path.join('data', 'backtest_races.json'))!;
    const races = JSON.parse(fs.readFileSync(file, 'utf-8')) as RaceSpec[];
    if (!Array.isArray(races) || races.length === 0) {
        console.log(`No races in ${file}. Fill it with past race ids first.`);
        process.exit(0);
    }

    const it = Number(arg('--iters', '120')) || 120;
    const sigma = Number(arg('--sigma', '0.15')) || 0.15;
    const outPath = arg('--out', path.join('data', 'modelWeights.json'))!;

    const base = getModelWeights(); // file + default
    let best = base;
    let bestScore = await evalWeightsOnSet(races, best);

    console.log(`Start: score(logloss)=${bestScore.toFixed(6)} base=${JSON.stringify(best)}`);

    for (let k = 1; k <= it; k++) {
        const cand = mutate(best, sigma);
        const score = await evalWeightsOnSet(races, cand);
        if (score < bestScore) {
            bestScore = score;
            best = cand;
            console.log(`[BEST] iter=${k} score=${bestScore.toFixed(6)} w=${JSON.stringify(best)}`);
        } else if (k % 10 === 0) {
            console.log(`[..] iter=${k} curBest=${bestScore.toFixed(6)}`);
        }
    }

    saveModelWeightsToFile(best, outPath);
    console.log(`Saved best weights to ${outPath}`);
    console.log(`Best score(logloss)=${bestScore.toFixed(6)}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
