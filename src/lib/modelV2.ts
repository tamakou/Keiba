// src/lib/modelV2.ts
// Model v2: last5/馬場/距離/脚質/コース/外部統計を統合

import { Race, Horse, HorseRun } from './types';
import { normalizeBaba, parseRaceCourse, parseSurfaceDistance, Surface, Baba } from './courseParse';
import { findCourseProfile, estimatePaceIndex } from './courseProfiles';
import { PersonStats, canonicalDbUrl } from './externalStats';
import { getModelWeights, ModelWeights } from './modelWeights';

export interface ModelV2Options {
    jockeyStatsByUrl?: Map<string, PersonStats>;
    trainerStatsByUrl?: Map<string, PersonStats>;
    paceOverride?: number | null;              // Step2/Step3で使用
    weightsOverride?: Partial<ModelWeights>;   // Step3最適化で使用
}

export interface ModelV2Result {
    probs: number[];
    factorStrings: string[][];
    notes: string[];
    paceIndex: number; // -1..+1
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}

function median(nums: number[]): number | null {
    const a = nums.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
    if (a.length === 0) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function toNum(s: string | null): number | null {
    if (!s) return null;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
}

function inferStyleFromRuns(runs: HorseRun[] | null): { style: 'Front' | 'Stalker' | 'Mid' | 'Closer' | 'Unknown'; avgPos: number | null } {
    if (!runs || runs.length === 0) return { style: 'Unknown', avgPos: null };
    const pos: number[] = [];
    for (const r of runs) {
        const ptxt = r.passing || '';
        const m = ptxt.match(/^(\d{1,2})/);
        if (!m) continue;
        const p = parseInt(m[1], 10);
        if (Number.isFinite(p)) pos.push(p);
    }
    const avg = pos.length ? pos.reduce((a, b) => a + b, 0) / pos.length : null;
    if (avg == null) return { style: 'Unknown', avgPos: null };
    if (avg <= 3) return { style: 'Front', avgPos: avg };
    if (avg <= 6) return { style: 'Stalker', avgPos: avg };
    if (avg <= 10) return { style: 'Mid', avgPos: avg };
    return { style: 'Closer', avgPos: avg };
}

function formIndex(runs: HorseRun[] | null): number | null {
    if (!runs || runs.length === 0) return null;
    const w = [1.0, 0.85, 0.7, 0.55, 0.4];
    let sum = 0, sw = 0;
    for (let i = 0; i < Math.min(runs.length, 5); i++) {
        const f = toNum(runs[i].finish);
        if (f == null) continue;
        const v = clamp(1 / f, 0.05, 1.0);
        sum += v * w[i];
        sw += w[i];
    }
    if (sw === 0) return null;
    return sum / sw; // 0.05..1.0
}

function last3fMedian(runs: HorseRun[] | null): number | null {
    if (!runs || runs.length === 0) return null;
    const vals: number[] = [];
    for (const r of runs) {
        const s = r.last3f;
        if (!s) continue;
        const x = parseFloat(s);
        if (Number.isFinite(x)) vals.push(x);
    }
    return median(vals); // 小さいほど良い
}

function distMatchIndex(runs: HorseRun[] | null, todaySurface: Surface, todayDist: number | null): number | null {
    if (!runs || runs.length === 0 || todayDist == null) return null;
    let best = -999;
    for (const r of runs) {
        const { surface, distance } = parseSurfaceDistance(r.surfaceDistance);
        if (distance == null) continue;
        const dm = 1 - Math.min(1, Math.abs(distance - todayDist) / 800);
        const sm = surface === todaySurface ? 1.0 : 0.6;
        best = Math.max(best, dm * sm);
    }
    return best === -999 ? null : best;
}

function goingAffinityIndex(runs: HorseRun[] | null, todayBaba: Baba): number | null {
    if (!runs || runs.length === 0) return null;
    if (!(todayBaba === '重' || todayBaba === '不')) return null;

    const w = [1.0, 0.85, 0.7, 0.55, 0.4];
    let sum = 0, sw = 0;
    for (let i = 0; i < Math.min(runs.length, 5); i++) {
        const b = (runs[i].baba || '').trim();
        if (!(b.includes('重') || b.includes('不'))) continue;
        const f = toNum(runs[i].finish);
        if (f == null) continue;
        const v = clamp(1 / f, 0.05, 1.0);
        sum += v * w[i];
        sw += w[i];
    }
    if (sw === 0) return null;
    return sum / sw;
}

export function computeModelV2(race: Race, opts: ModelV2Options = {}): ModelV2Result {
    const W = getModelWeights(opts.weightsOverride);
    const horses = race.horses;
    const notes: string[] = [];

    const { surface, distance, direction } = parseRaceCourse(race.course);
    const todayBaba = normalizeBaba(race.baba);
    notes.push(`ModelV2: ${surface}${distance ?? '??'}m ${direction} baba=${todayBaba} weather=${race.weather}`);

    // per-horse base features
    const perHorse = horses.map(h => {
        const fi = formIndex(h.last5);
        const l3 = last3fMedian(h.last5);
        const dm = distMatchIndex(h.last5, surface, distance);
        const ga = goingAffinityIndex(h.last5, todayBaba);
        const st = inferStyleFromRuns(h.last5);
        return { fi, l3, dm, ga, style: st };
    });

    // field median last3f
    const l3All = perHorse.map(x => x.l3).filter((x): x is number => x != null);
    const l3Med = median(l3All);

    // course profile + pace
    const courseProfile = findCourseProfile({ venue: race.venue, surface, distance, direction });
    if (courseProfile) {
        notes.push(`コースプロファイル: ${courseProfile.venue} ${courseProfile.surface}${courseProfile.distance}m 内bias=${courseProfile.insideBias} 前bias=${courseProfile.frontBias}`);
    } else {
        notes.push('コースプロファイル: 該当データなし（デフォルトバイアス使用）');
    }

    const styleDist = { front: 0, stalker: 0, mid: 0, closer: 0 };
    perHorse.forEach(h => {
        const s = h.style.style;
        if (s === 'Front') styleDist.front++;
        else if (s === 'Stalker') styleDist.stalker++;
        else if (s === 'Mid') styleDist.mid++;
        else if (s === 'Closer') styleDist.closer++;
    });

    const paceRaw = clamp(estimatePaceIndex(styleDist), -1, 1);
    const paceIndex = (opts.paceOverride != null) ? clamp(opts.paceOverride, -1, 1) : paceRaw;
    notes.push(`ペース推定: ${paceIndex.toFixed(2)} (前${styleDist.front}/先${styleDist.stalker}/中${styleDist.mid}/差${styleDist.closer})`);

    // jockey/trainer proxy mean (fallback)
    const overallFi = perHorse.map(x => x.fi).filter((x): x is number => x != null);
    const overallFiMean = overallFi.length ? overallFi.reduce((a, b) => a + b, 0) / overallFi.length : null;
    const jAgg = new Map<string, { sum: number; n: number }>();
    const tAgg = new Map<string, { sum: number; n: number }>();
    horses.forEach((h, i) => {
        const fi = perHorse[i].fi;
        if (fi == null) return;
        if (h.jockey && h.jockey !== '取得不可') {
            const cur = jAgg.get(h.jockey) ?? { sum: 0, n: 0 };
            cur.sum += fi; cur.n += 1;
            jAgg.set(h.jockey, cur);
        }
        if (h.trainer && h.trainer !== '取得不可') {
            const cur = tAgg.get(h.trainer) ?? { sum: 0, n: 0 };
            cur.sum += fi; cur.n += 1;
            tAgg.set(h.trainer, cur);
        }
    });
    const jockeyMean = new Map<string, number>();
    const trainerMean = new Map<string, number>();
    for (const [k, v] of jAgg.entries()) jockeyMean.set(k, v.sum / v.n);
    for (const [k, v] of tAgg.entries()) trainerMean.set(k, v.sum / v.n);

    const isSprint = distance != null && distance <= 1400;
    const isLong = distance != null && distance >= 2000;

    const rawScores: number[] = [];
    const factorStrings: string[][] = [];

    horses.forEach((h, i) => {
        const factors: { label: string; delta: number }[] = [];
        let logS = 0;

        // 1) 枠 + insideBias
        if (h.gate > 0) {
            const inside = h.gate <= 2;
            const outside = h.gate >= 7 && horses.length > 10;
            const insideBias = (courseProfile?.insideBias ?? 0.1) * W.insideBiasScale;
            if (inside) {
                const d = 0.03 + insideBias * 0.05;
                logS += d;
                factors.push({ label: '内枠', delta: d });
            }
            if (outside) {
                const d = -0.02 - insideBias * 0.03;
                logS += d;
                factors.push({ label: '外枠', delta: d });
            }
        }

        // 2) 馬体増減（既存の軽い扱い）
        if (h.weightChange != null) {
            if (Math.abs(h.weightChange) <= 2) { logS += 0.02; factors.push({ label: '馬体安定', delta: +0.02 }); }
            else if (Math.abs(h.weightChange) >= 10) { logS -= 0.08; factors.push({ label: '馬体増減大', delta: -0.08 }); }
        }

        // 3) 近走フォーム
        const fi = perHorse[i].fi;
        if (fi != null) {
            const x = clamp((fi - 0.25) / 0.25, -1, +1);
            const d = W.form * x;
            logS += d;
            factors.push({ label: '近走フォーム', delta: d });
        }

        // 4) 上がり
        const l3 = perHorse[i].l3;
        if (l3 != null && l3Med != null) {
            const z = clamp((l3Med - l3) / 0.8, -1, +1);
            const d = W.last3f * z;
            logS += d;
            factors.push({ label: '上がり性能', delta: d });
        }

        // 5) 距離適性
        const dm = perHorse[i].dm;
        if (dm != null) {
            const d = W.dist * clamp((dm - 0.6) / 0.4, -1, +1);
            logS += d;
            factors.push({ label: '距離適性', delta: d });
        }

        // 6) 重不適性
        const ga = perHorse[i].ga;
        if (ga != null) {
            const x = clamp((ga - 0.25) / 0.25, -1, +1);
            const d = W.going * x;
            logS += d;
            factors.push({ label: '重不適性', delta: d });
        }

        // 7) 脚質×距離×コース×ペース
        const st = perHorse[i].style.style;
        let styleD = 0;
        if (isSprint) styleD = (st === 'Front' ? +0.08 : st === 'Stalker' ? +0.03 : st === 'Closer' ? -0.05 : 0);
        else if (isLong) styleD = (st === 'Closer' ? +0.05 : st === 'Front' ? -0.03 : 0);

        const frontBias = (courseProfile?.frontBias ?? 0) * W.frontBiasScale;
        if (st === 'Front' || st === 'Stalker') styleD += frontBias * 0.06;
        if (st === 'Mid' || st === 'Closer') styleD -= frontBias * 0.04;

        const paceEff = paceIndex * W.paceScale;
        if (st === 'Closer') styleD += paceEff * 0.05;
        if (st === 'Front') styleD -= paceEff * 0.04;

        styleD *= W.styleScale;
        if (styleD !== 0) {
            logS += styleD;
            factors.push({ label: '脚質×コース', delta: styleD });
        }

        // 8) 騎手（外部→proxy）
        const jUrl = h.jockeyUrl ? canonicalDbUrl(h.jockeyUrl, 'jockey') : null;
        const jStat = (jUrl && opts.jockeyStatsByUrl) ? opts.jockeyStatsByUrl.get(jUrl) : null;
        if (jStat?.placeRate != null) {
            const rel = clamp((jStat.placeRate - 0.25) / 0.08, -1, +1);
            const d = W.jockey * rel;
            logS += d;
            factors.push({ label: '騎手(外部)', delta: d });
        } else if (overallFiMean != null && h.jockey && h.jockey !== '取得不可') {
            const jm = jockeyMean.get(h.jockey);
            if (jm != null) {
                const rel = clamp((jm - overallFiMean) / 0.15, -1, +1);
                const d = W.jockey * rel;
                logS += d;
                factors.push({ label: '騎手(proxy)', delta: d });
            }
        }

        // 9) 調教師（外部→proxy）
        const tUrl = h.trainerUrl ? canonicalDbUrl(h.trainerUrl, 'trainer') : null;
        const tStat = (tUrl && opts.trainerStatsByUrl) ? opts.trainerStatsByUrl.get(tUrl) : null;
        if (tStat?.placeRate != null) {
            const rel = clamp((tStat.placeRate - 0.25) / 0.08, -1, +1);
            const d = W.trainer * rel;
            logS += d;
            factors.push({ label: '調教師(外部)', delta: d });
        } else if (overallFiMean != null && h.trainer && h.trainer !== '取得不可') {
            const tm = trainerMean.get(h.trainer);
            if (tm != null) {
                const rel = clamp((tm - overallFiMean) / 0.15, -1, +1);
                const d = W.trainer * rel;
                logS += d;
                factors.push({ label: '調教師(proxy)', delta: d });
            }
        }

        const score = Math.exp(logS);
        rawScores.push(score);

        const top = [...factors].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
        factorStrings.push(top.length ? top.map(f => `${f.label}${f.delta >= 0 ? '+' : ''}${f.delta.toFixed(2)}`) : ['情報不足']);
    });

    const sum = rawScores.reduce((a, b) => a + b, 0);
    const probs = sum > 0 ? rawScores.map(s => s / sum) : rawScores.map(() => 1 / rawScores.length);

    notes.push(`Weights: form=${W.form} last3f=${W.last3f} dist=${W.dist} going=${W.going} styleScale=${W.styleScale} jockey=${W.jockey} trainer=${W.trainer}`);

    return { probs, factorStrings, notes, paceIndex };
}
