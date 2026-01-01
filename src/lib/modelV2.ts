// src/lib/modelV2.ts
// 世界一級推定モデル v2
// オッズ無しでも成立する実力推定（last5/馬場/距離/脚質/騎手統計）

import { Race, Horse, HorseRun } from './types';
import { normalizeBaba, parseRaceCourse, parseSurfaceDistance, Surface, Baba } from './courseParse';
import { findCourseProfile, estimatePaceIndex, CourseProfile } from './courseProfiles';
import { PersonStats } from './externalStats';

export interface ModelV2Options {
    jockeyStatsByUrl?: Map<string, PersonStats>;
    trainerStatsByUrl?: Map<string, PersonStats>;
    paceOverride?: number | null; // Step2で使用
}

// ============================================================================
// ユーティリティ
// ============================================================================

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}

function toNum(s: string | null): number | null {
    if (!s) return null;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
}

function median(nums: number[]): number | null {
    const a = nums.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
    if (a.length === 0) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// ============================================================================
// 特徴量計算
// ============================================================================

type RunningStyle = 'Front' | 'Stalker' | 'Mid' | 'Closer' | 'Unknown';

/**
 * 通過順から脚質を推定
 * Front: 平均先頭3位以内
 * Stalker: 4-6位
 * Mid: 7-10位
 * Closer: 11位以降
 */
function inferStyleFromRuns(runs: HorseRun[] | null): { style: RunningStyle; avgPos: number | null } {
    if (!runs || runs.length === 0) return { style: 'Unknown', avgPos: null };
    const pos: number[] = [];
    for (const r of runs) {
        if (!r.passing) continue;
        const m = r.passing.match(/^(\d{1,2})/);
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

/**
 * フォーム指数：直近ほど重みを大きく、着順が良いほど高い
 * 返り値: 0.05〜1.0
 */
function formIndex(runs: HorseRun[] | null): number | null {
    if (!runs || runs.length === 0) return null;
    const w = [1.0, 0.85, 0.7, 0.55, 0.4];
    let sum = 0, sw = 0;
    for (let i = 0; i < Math.min(runs.length, 5); i++) {
        const f = toNum(runs[i].finish);
        if (f == null) continue;
        // finish=1 => 1.0、finish=10 => 0.1
        const v = clamp(1 / f, 0.05, 1.0);
        sum += v * w[i];
        sw += w[i];
    }
    if (sw === 0) return null;
    return sum / sw;
}

/**
 * 距離適性指数：今日の距離と近走距離の一致度
 * 返り値: 0.0〜1.0
 */
function distMatchIndex(runs: HorseRun[] | null, todaySurface: Surface, todayDist: number | null): number | null {
    if (!runs || runs.length === 0 || todayDist == null) return null;
    let best = -999;
    for (const r of runs) {
        const { surface, distance: dist } = parseSurfaceDistance(r.surfaceDistance);
        if (dist == null) continue;
        // 距離差 0 => 1.0、800m差 => 0.0
        const dm = 1 - Math.min(1, Math.abs(dist - todayDist) / 800);
        const sm = surface === todaySurface ? 1.0 : 0.6; // surface違いは大きく減点
        best = Math.max(best, dm * sm);
    }
    return best === -999 ? null : best;
}

/**
 * 馬場適性指数：重/不での好走実績
 * 返り値: 0.05〜1.0（該当なしはnull）
 */
function goingAffinityIndex(runs: HorseRun[] | null, todayBaba: Baba): number | null {
    if (!runs || runs.length === 0 || todayBaba === '不明') return null;
    // 今日が重/不のときのみ、重/不でのフォームを評価
    if (todayBaba !== '重' && todayBaba !== '不') return null;

    const w = [1.0, 0.85, 0.7, 0.55, 0.4];
    let sum = 0, sw = 0;
    for (let i = 0; i < Math.min(runs.length, 5); i++) {
        const b = normalizeBaba(runs[i].baba);
        if (b !== '重' && b !== '不') continue;
        const f = toNum(runs[i].finish);
        if (f == null) continue;
        const v = clamp(1 / f, 0.05, 1.0);
        sum += v * w[i];
        sw += w[i];
    }
    if (sw === 0) return null;
    return sum / sw;
}

/**
 * 上がり中央値（last3f）
 * 小さいほど良い
 */
function last3fMedian(runs: HorseRun[] | null): number | null {
    if (!runs || runs.length === 0) return null;
    const vals: number[] = [];
    for (const r of runs) {
        if (!r.last3f) continue;
        const x = parseFloat(r.last3f);
        if (Number.isFinite(x)) vals.push(x);
    }
    return median(vals);
}

// ============================================================================
// メイン推定関数
// ============================================================================

export interface ModelV2Result {
    probs: number[];           // 各馬の勝率推定
    factorStrings: string[][]; // 各馬の主要因（表示用）
    notes: string[];           // デバッグ/メモ
}

export function computeModelV2(race: Race, opts: ModelV2Options = {}): ModelV2Result {
    const horses = race.horses;
    const notes: string[] = [];

    // コース情報パース
    const { surface, distance, direction } = parseRaceCourse(race.course);
    const todayBaba = normalizeBaba(race.baba);
    notes.push(`ModelV2: ${surface}${distance ?? '??'}m ${direction} baba=${todayBaba} weather=${race.weather}`);

    // 各馬の特徴量
    const perHorse = horses.map(h => ({
        fi: formIndex(h.last5),
        l3: last3fMedian(h.last5),
        dm: distMatchIndex(h.last5, surface, distance),
        ga: goingAffinityIndex(h.last5, todayBaba),
        style: inferStyleFromRuns(h.last5),
    }));

    // フィールド中央値（上がり比較用）
    const l3All = perHorse.map(x => x.l3).filter((x): x is number => x != null);
    const l3Med = median(l3All);

    // 騎手/調教師の統計代理（レース内の担当馬フォーム平均）
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

    // コースプロファイル検索
    const courseProfile = findCourseProfile({ venue: race.venue, surface, distance, direction });
    if (courseProfile) {
        notes.push(`コースプロファイル: ${courseProfile.venue} ${courseProfile.surface}${courseProfile.distance}m 内bias=${courseProfile.insideBias} 前bias=${courseProfile.frontBias}`);
    } else {
        notes.push('コースプロファイル: 該当データなし（デフォルトバイアス使用）');
    }

    // ペース推定（脚質分布から）
    const styleDistribution = { front: 0, stalker: 0, mid: 0, closer: 0 };
    perHorse.forEach(h => {
        const s = h.style.style;
        if (s === 'Front') styleDistribution.front++;
        else if (s === 'Stalker') styleDistribution.stalker++;
        else if (s === 'Mid') styleDistribution.mid++;
        else if (s === 'Closer') styleDistribution.closer++;
    });
    const paceIndex = clamp(estimatePaceIndex(styleDistribution), -1, 1);
    notes.push(`ペース推定: ${paceIndex.toFixed(2)} (前${styleDistribution.front}/先${styleDistribution.stalker}/中${styleDistribution.mid}/差${styleDistribution.closer})`);

    // 距離×脚質バイアス
    const isSprint = distance != null && distance <= 1400;
    const isLong = distance != null && distance >= 2000;

    // スコア計算
    const rawScores: number[] = [];
    const factorStrings: string[][] = [];

    horses.forEach((h, i) => {
        const factors: { label: string; delta: number }[] = [];
        let logS = 0;

        // 1) 枚（内外）+ コースバイアス
        if (h.gate > 0) {
            const insideBias = courseProfile?.insideBias ?? 0.1; // デフォルトは軽い内有利
            const inside = h.gate <= 2;
            const outside = h.gate >= 7 && horses.length > 10;
            if (inside) {
                const d = 0.03 + insideBias * 0.05;
                logS += d;
                factors.push({ label: '内枚', delta: d });
            }
            if (outside) {
                const d = -0.02 - insideBias * 0.03;
                logS += d;
                factors.push({ label: '外枚', delta: d });
            }
        }

        // 2) 馬体増減
        if (h.weightChange != null) {
            if (Math.abs(h.weightChange) <= 2) {
                logS += 0.02;
                factors.push({ label: '馬体安定', delta: +0.02 });
            } else if (Math.abs(h.weightChange) >= 10) {
                logS -= 0.08;
                factors.push({ label: '馬体増減大', delta: -0.08 });
            }
        }

        // 3) フォーム（近走）
        const fi = perHorse[i].fi;
        if (fi != null) {
            const x = clamp((fi - 0.25) / 0.25, -1, +1);
            const d = 0.22 * x;
            logS += d;
            factors.push({ label: '近走フォーム', delta: d });
        }

        // 4) 上がり性能
        const l3 = perHorse[i].l3;
        if (l3 != null && l3Med != null) {
            const z = clamp((l3Med - l3) / 0.8, -1, +1);
            const d = 0.18 * z;
            logS += d;
            factors.push({ label: '上がり性能', delta: d });
        }

        // 5) 距離適性
        const dm = perHorse[i].dm;
        if (dm != null) {
            const d = 0.14 * clamp((dm - 0.6) / 0.4, -1, +1);
            logS += d;
            factors.push({ label: '距離適性', delta: d });
        }

        // 6) 馬場適性（重/不の時のみ）
        const ga = perHorse[i].ga;
        if (ga != null) {
            const x = clamp((ga - 0.25) / 0.25, -1, +1);
            const d = 0.12 * x;
            logS += d;
            factors.push({ label: '重馬場適性', delta: d });
        }

        // 7) 脚質×距離バイアス + コースfrontBias + ペース
        const st = perHorse[i].style.style;
        const frontBias = courseProfile?.frontBias ?? 0;
        // ベース効果
        let styleD = 0;
        if (isSprint) {
            styleD = st === 'Front' ? +0.08 : st === 'Stalker' ? +0.03 : st === 'Closer' ? -0.05 : 0;
        } else if (isLong) {
            styleD = st === 'Closer' ? +0.05 : st === 'Front' ? -0.03 : 0;
        }
        // コースfrontBias上乗せ
        if (st === 'Front' || st === 'Stalker') {
            styleD += frontBias * 0.06;
        } else if (st === 'Mid' || st === 'Closer') {
            styleD -= frontBias * 0.04;
        }
        // ペース上乗せ（ハイペースなら差し有利）
        if (st === 'Closer') {
            styleD += paceIndex * 0.05;
        } else if (st === 'Front') {
            styleD -= paceIndex * 0.04;
        }
        if (styleD !== 0) {
            logS += styleD;
            factors.push({ label: '脚質×コース', delta: styleD });
        }

        // 8) 騎手（外部統計→proxy）
        const jUrl = h.jockeyUrl || null;
        const jStat = (jUrl && opts.jockeyStatsByUrl) ? opts.jockeyStatsByUrl.get(jUrl) : null;
        if (jStat?.placeRate != null) {
            // placeRateを使用（安定）。平均0.25を基準
            const rel = clamp((jStat.placeRate - 0.25) / 0.08, -1, +1);
            const d = 0.06 * rel;
            logS += d;
            factors.push({ label: '騎手(外部)', delta: d });
        } else if (overallFiMean != null && h.jockey && h.jockey !== '取得不可') {
            const jm = jockeyMean.get(h.jockey);
            if (jm != null) {
                const rel = clamp((jm - overallFiMean) / 0.15, -1, +1);
                const d = 0.06 * rel;
                logS += d;
                factors.push({ label: '騎手(proxy)', delta: d });
            }
        }

        // 9) 調教師（外部統計→proxy）
        const tUrl = h.trainerUrl || null;
        const tStat = (tUrl && opts.trainerStatsByUrl) ? opts.trainerStatsByUrl.get(tUrl) : null;
        if (tStat?.placeRate != null) {
            const rel = clamp((tStat.placeRate - 0.25) / 0.08, -1, +1);
            const d = 0.05 * rel;
            logS += d;
            factors.push({ label: '調教師(外部)', delta: d });
        } else if (overallFiMean != null && h.trainer && h.trainer !== '取得不可') {
            const tm = trainerMean.get(h.trainer);
            if (tm != null) {
                const rel = clamp((tm - overallFiMean) / 0.15, -1, +1);
                const d = 0.05 * rel;
                logS += d;
                factors.push({ label: '調教師(proxy)', delta: d });
            }
        }

        // スコア（exp で正の値に）
        const score = Math.exp(logS);
        rawScores.push(score);

        // 主要因（寄与が大きい順に3つ）
        const top = [...factors]
            .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
            .slice(0, 3);

        const strs = top.length
            ? top.map(f => `${f.label}${f.delta >= 0 ? '+' : ''}${f.delta.toFixed(2)}`)
            : ['情報不足'];

        factorStrings.push(strs);
    });

    // 正規化 → 確率
    const sum = rawScores.reduce((a, b) => a + b, 0);
    const probs = sum > 0 ? rawScores.map(s => s / sum) : rawScores.map(() => 1 / rawScores.length);

    return { probs, factorStrings, notes };
}
