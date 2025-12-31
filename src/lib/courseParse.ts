// src/lib/courseParse.ts
// コース解析ユーティリティ（surface / distance / direction / baba正規化）

export type Surface = '芝' | 'ダ' | '障' | '不明';
export type Baba = '良' | '稍' | '重' | '不' | '不明';
export type Direction = '右' | '左' | '直' | '不明';

export interface ParsedCourse {
    surface: Surface;
    distance: number | null;
    direction: Direction;
}

/**
 * コース文字列から surface / distance / direction を抽出
 * 例: "ダ1200m(右)" → { surface: 'ダ', distance: 1200, direction: '右' }
 */
export function parseRaceCourse(course: string): ParsedCourse {
    const c = (course || '').replace(/\s+/g, '');

    // 例: "ダ1200m(右)" / "芝2000m(左)" / "ダ1600m(右)"
    const m = c.match(/([芝ダ障])(\d{3,4})m?/);
    const surface = (m?.[1] as Surface) ?? '不明';
    const distance = m?.[2] ? parseInt(m[2], 10) : null;

    let direction: Direction = '不明';
    if (c.includes('右')) direction = '右';
    else if (c.includes('左')) direction = '左';
    else if (c.includes('直')) direction = '直';

    return {
        surface,
        distance: Number.isFinite(distance as number) ? (distance as number) : null,
        direction,
    };
}

/**
 * 馬場状態を正規化
 * 例: "不良" → '不', "稍重" → '稍', "良" → '良'
 */
export function normalizeBaba(baba: string | null | undefined): Baba {
    const b = (baba || '').trim();
    if (b.includes('良') && !b.includes('不')) return '良';
    if (b.includes('稍')) return '稍';
    if (b.includes('重') && !b.includes('稍')) return '重';
    if (b.includes('不')) return '不';
    return '不明';
}

/**
 * surfaceDistance文字列をパース
 * 例: "ダ1600" → { surface: 'ダ', distance: 1600 }
 */
export function parseSurfaceDistance(sd: string | null): { surface: Surface; distance: number | null } {
    if (!sd) return { surface: '不明', distance: null };
    const m = sd.match(/([芝ダ障])(\d{3,4})/);
    const surface = (m?.[1] as Surface) ?? '不明';
    const dist = m?.[2] ? parseInt(m[2], 10) : null;
    return {
        surface,
        distance: Number.isFinite(dist as number) ? (dist as number) : null,
    };
}
