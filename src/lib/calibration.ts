import fs from 'fs';
import path from 'path';

export type Platt = { a: number; b: number };

export interface CalibrationParams {
    version: number;
    winTemperature: number; // >0
    top2Platt: Platt;
    top3Platt: Platt;
}

const DEFAULT: CalibrationParams = {
    version: 1,
    winTemperature: 1.0,
    top2Platt: { a: 1.0, b: 0.0 },
    top3Platt: { a: 1.0, b: 0.0 },
};

let cached: { mtimeMs: number; params: CalibrationParams } | null = null;

export function getCalibrationPath(): string {
    return process.env.KEIBA_CALIBRATION_PATH || path.join(process.cwd(), 'data', 'calibration.json');
}

export function loadCalibration(): CalibrationParams {
    const p = getCalibrationPath();
    try {
        if (!fs.existsSync(p)) return DEFAULT;
        const st = fs.statSync(p);
        if (cached && cached.mtimeMs === st.mtimeMs) return cached.params;
        const raw = fs.readFileSync(p, 'utf-8');
        const j = JSON.parse(raw) as Partial<CalibrationParams>;
        const params: CalibrationParams = {
            version: j.version ?? 1,
            winTemperature: j.winTemperature ?? 1.0,
            top2Platt: j.top2Platt ?? { a: 1, b: 0 },
            top3Platt: j.top3Platt ?? { a: 1, b: 0 },
        };
        cached = { mtimeMs: st.mtimeMs, params };
        return params;
    } catch {
        return DEFAULT;
    }
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}

function logit(p: number): number {
    const x = clamp(p, 1e-12, 1 - 1e-12);
    return Math.log(x / (1 - x));
}

function sigmoid(z: number): number {
    if (z >= 0) {
        const e = Math.exp(-z);
        return 1 / (1 + e);
    } else {
        const e = Math.exp(z);
        return e / (1 + e);
    }
}

export function applyTemperature(win: number[], T: number): number[] {
    const t = Math.max(0.05, T);
    const pow = 1 / t;
    const a = win.map(p => Math.pow(clamp(p, 1e-12, 1), pow));
    const s = a.reduce((x, y) => x + y, 0);
    return s > 0 ? a.map(x => x / s) : win;
}

export function applyPlatt(p: number, platt: Platt): number {
    const z = platt.a * logit(p) + platt.b;
    return clamp(sigmoid(z), 0, 1);
}

export function calibrateWinTopK(args: {
    win: number[];
    top2: number[];
    top3: number[];
}): { win: number[]; top2: number[]; top3: number[]; params: CalibrationParams } {
    const params = loadCalibration();
    const win = applyTemperature(args.win, params.winTemperature);
    const top2 = args.top2.map(p => applyPlatt(p, params.top2Platt));
    const top3 = args.top3.map(p => applyPlatt(p, params.top3Platt));
    return { win, top2, top3, params };
}
