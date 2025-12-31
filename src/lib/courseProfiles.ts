// src/lib/courseProfiles.ts
// コースプロファイル辞書 - コース特性（バイアス/直線長/坂等）

import { Surface, Direction } from './courseParse';

/**
 * コースプロファイル
 * insideBias/frontBias: -1..+1 (+は内有利/前有利、-は外有利/差し有利)
 */
export interface CourseProfile {
    venue: string;              // 中山/東京/京都/阪神/大井 等
    surface: Surface;           // 芝/ダ/障
    distance: number;           // 1200/1600/2000...
    direction: Direction;       // 右/左/直

    // -1..+1 バイアス
    insideBias: number;         // +: 内有利, -: 外有利
    frontBias: number;          // +: 先行有利, -: 差し有利

    // 任意（後で拡張）
    straightMeters?: number;    // 直線長（m）
    hasSlope?: boolean;         // 坂有無
    firstTurnMeters?: number;   // スタートから1角までの距離

    notes?: string;
}

/**
 * コースプロファイル辞書
 * 将来的にはJSONファイルや外部データソースからロードする設計も可能
 */
export const COURSE_PROFILES: CourseProfile[] = [
    // ============================================================================
    // JRA 中央競馬
    // ============================================================================

    // 中山 (Nakayama)
    { venue: '中山', surface: '芝', distance: 1200, direction: '右', insideBias: 0.2, frontBias: 0.3, straightMeters: 310, hasSlope: true },
    { venue: '中山', surface: '芝', distance: 1600, direction: '右', insideBias: 0.1, frontBias: 0.1, straightMeters: 310, hasSlope: true },
    { venue: '中山', surface: '芝', distance: 2000, direction: '右', insideBias: 0.1, frontBias: 0.0, straightMeters: 310, hasSlope: true },
    { venue: '中山', surface: '芝', distance: 2200, direction: '右', insideBias: 0.0, frontBias: -0.1, straightMeters: 310, hasSlope: true },
    { venue: '中山', surface: '芝', distance: 2500, direction: '右', insideBias: 0.0, frontBias: -0.2, straightMeters: 310, hasSlope: true },
    { venue: '中山', surface: 'ダ', distance: 1200, direction: '右', insideBias: 0.3, frontBias: 0.4, straightMeters: 308, hasSlope: false },
    { venue: '中山', surface: 'ダ', distance: 1800, direction: '右', insideBias: 0.2, frontBias: 0.2, straightMeters: 308, hasSlope: false },

    // 東京 (Tokyo)
    { venue: '東京', surface: '芝', distance: 1400, direction: '左', insideBias: 0.0, frontBias: -0.1, straightMeters: 525, hasSlope: false },
    { venue: '東京', surface: '芝', distance: 1600, direction: '左', insideBias: -0.1, frontBias: -0.2, straightMeters: 525, hasSlope: false },
    { venue: '東京', surface: '芝', distance: 1800, direction: '左', insideBias: -0.1, frontBias: -0.2, straightMeters: 525, hasSlope: false },
    { venue: '東京', surface: '芝', distance: 2000, direction: '左', insideBias: -0.1, frontBias: -0.3, straightMeters: 525, hasSlope: false },
    { venue: '東京', surface: '芝', distance: 2400, direction: '左', insideBias: 0.0, frontBias: -0.3, straightMeters: 525, hasSlope: false },
    { venue: '東京', surface: 'ダ', distance: 1400, direction: '左', insideBias: 0.1, frontBias: 0.1, straightMeters: 501, hasSlope: false },
    { venue: '東京', surface: 'ダ', distance: 1600, direction: '左', insideBias: 0.0, frontBias: 0.0, straightMeters: 501, hasSlope: false },
    { venue: '東京', surface: 'ダ', distance: 2100, direction: '左', insideBias: 0.0, frontBias: -0.1, straightMeters: 501, hasSlope: false },

    // 京都 (Kyoto)
    { venue: '京都', surface: '芝', distance: 1200, direction: '右', insideBias: 0.2, frontBias: 0.3, straightMeters: 404, hasSlope: true },
    { venue: '京都', surface: '芝', distance: 1400, direction: '右', insideBias: 0.1, frontBias: 0.2, straightMeters: 404, hasSlope: true },
    { venue: '京都', surface: '芝', distance: 1600, direction: '右', insideBias: 0.0, frontBias: 0.0, straightMeters: 404, hasSlope: true },
    { venue: '京都', surface: '芝', distance: 2000, direction: '右', insideBias: 0.0, frontBias: -0.1, straightMeters: 404, hasSlope: true },
    { venue: '京都', surface: '芝', distance: 2400, direction: '右', insideBias: 0.0, frontBias: -0.2, straightMeters: 404, hasSlope: true },
    { venue: '京都', surface: 'ダ', distance: 1200, direction: '右', insideBias: 0.2, frontBias: 0.3, straightMeters: 329, hasSlope: false },
    { venue: '京都', surface: 'ダ', distance: 1800, direction: '右', insideBias: 0.1, frontBias: 0.1, straightMeters: 329, hasSlope: false },

    // 阪神 (Hanshin)
    { venue: '阪神', surface: '芝', distance: 1200, direction: '右', insideBias: 0.2, frontBias: 0.3, straightMeters: 473, hasSlope: true },
    { venue: '阪神', surface: '芝', distance: 1400, direction: '右', insideBias: 0.1, frontBias: 0.2, straightMeters: 473, hasSlope: true },
    { venue: '阪神', surface: '芝', distance: 1600, direction: '右', insideBias: 0.0, frontBias: 0.0, straightMeters: 473, hasSlope: true },
    { venue: '阪神', surface: '芝', distance: 1800, direction: '右', insideBias: 0.0, frontBias: -0.1, straightMeters: 473, hasSlope: true },
    { venue: '阪神', surface: '芝', distance: 2000, direction: '右', insideBias: 0.0, frontBias: -0.2, straightMeters: 473, hasSlope: true },
    { venue: '阪神', surface: '芝', distance: 2200, direction: '右', insideBias: 0.0, frontBias: -0.2, straightMeters: 473, hasSlope: true },
    { venue: '阪神', surface: 'ダ', distance: 1200, direction: '右', insideBias: 0.2, frontBias: 0.3, straightMeters: 352, hasSlope: false },
    { venue: '阪神', surface: 'ダ', distance: 1400, direction: '右', insideBias: 0.1, frontBias: 0.2, straightMeters: 352, hasSlope: false },
    { venue: '阪神', surface: 'ダ', distance: 1800, direction: '右', insideBias: 0.1, frontBias: 0.1, straightMeters: 352, hasSlope: false },

    // ============================================================================
    // NAR 地方競馬（主要場）
    // ============================================================================

    // 大井 (Oi)
    { venue: '大井', surface: 'ダ', distance: 1200, direction: '右', insideBias: 0.3, frontBias: 0.4, straightMeters: 386, hasSlope: false },
    { venue: '大井', surface: 'ダ', distance: 1400, direction: '右', insideBias: 0.2, frontBias: 0.3, straightMeters: 386, hasSlope: false },
    { venue: '大井', surface: 'ダ', distance: 1600, direction: '右', insideBias: 0.2, frontBias: 0.2, straightMeters: 386, hasSlope: false },
    { venue: '大井', surface: 'ダ', distance: 1800, direction: '右', insideBias: 0.1, frontBias: 0.1, straightMeters: 386, hasSlope: false },
    { venue: '大井', surface: 'ダ', distance: 2000, direction: '右', insideBias: 0.1, frontBias: 0.0, straightMeters: 386, hasSlope: false },

    // 川崎 (Kawasaki)
    { venue: '川崎', surface: 'ダ', distance: 900, direction: '左', insideBias: 0.4, frontBias: 0.5, straightMeters: 300, hasSlope: false },
    { venue: '川崎', surface: 'ダ', distance: 1400, direction: '左', insideBias: 0.2, frontBias: 0.3, straightMeters: 300, hasSlope: false },
    { venue: '川崎', surface: 'ダ', distance: 1600, direction: '左', insideBias: 0.2, frontBias: 0.2, straightMeters: 300, hasSlope: false },
    { venue: '川崎', surface: 'ダ', distance: 2100, direction: '左', insideBias: 0.1, frontBias: 0.0, straightMeters: 300, hasSlope: false },

    // 船橋 (Funabashi)
    { venue: '船橋', surface: 'ダ', distance: 1000, direction: '左', insideBias: 0.3, frontBias: 0.4, straightMeters: 308, hasSlope: false },
    { venue: '船橋', surface: 'ダ', distance: 1200, direction: '左', insideBias: 0.3, frontBias: 0.4, straightMeters: 308, hasSlope: false },
    { venue: '船橋', surface: 'ダ', distance: 1600, direction: '左', insideBias: 0.2, frontBias: 0.2, straightMeters: 308, hasSlope: false },
    { venue: '船橋', surface: 'ダ', distance: 1800, direction: '左', insideBias: 0.1, frontBias: 0.1, straightMeters: 308, hasSlope: false },

    // 浦和 (Urawa)
    { venue: '浦和', surface: 'ダ', distance: 800, direction: '右', insideBias: 0.4, frontBias: 0.5, straightMeters: 220, hasSlope: false },
    { venue: '浦和', surface: 'ダ', distance: 1400, direction: '右', insideBias: 0.3, frontBias: 0.4, straightMeters: 220, hasSlope: false },
    { venue: '浦和', surface: 'ダ', distance: 1500, direction: '右', insideBias: 0.2, frontBias: 0.3, straightMeters: 220, hasSlope: false },
    { venue: '浦和', surface: 'ダ', distance: 2000, direction: '右', insideBias: 0.1, frontBias: 0.1, straightMeters: 220, hasSlope: false },
];

/**
 * コースプロファイルを検索
 */
export function findCourseProfile(args: {
    venue: string | null | undefined;
    surface: Surface;
    distance: number | null;
    direction: Direction;
}): CourseProfile | null {
    if (!args.venue || args.distance == null) return null;

    // 完全一致
    const exact = COURSE_PROFILES.find(p =>
        p.venue === args.venue &&
        p.surface === args.surface &&
        p.direction === args.direction &&
        p.distance === args.distance
    );
    if (exact) return exact;

    // 距離近似マッチ（±200m以内で最も近いもの）
    const nearMatch = COURSE_PROFILES
        .filter(p =>
            p.venue === args.venue &&
            p.surface === args.surface &&
            p.direction === args.direction &&
            Math.abs(p.distance - args.distance!) <= 200
        )
        .sort((a, b) => Math.abs(a.distance - args.distance!) - Math.abs(b.distance - args.distance!));

    return nearMatch.length > 0 ? nearMatch[0] : null;
}

/**
 * ペース指数を推定
 * 出走馬の脚質分布から「ハイペース/ミドル/スロー」を推定
 * @returns -1..+1 (+: ハイペース=差し有利, -: スロー=前有利)
 */
export function estimatePaceIndex(styleDistribution: { front: number; stalker: number; mid: number; closer: number }): number {
    const total = styleDistribution.front + styleDistribution.stalker + styleDistribution.mid + styleDistribution.closer;
    if (total === 0) return 0;

    const frontRatio = styleDistribution.front / total;
    const closerRatio = styleDistribution.closer / total;

    // 前が多い → ハイペース → 差し有利 → +
    // 後ろが多い → スロー → 前有利 → -
    return (frontRatio - closerRatio) * 1.5; // clamp は呼び出し側で行う
}
