// src/lib/modelWeights.ts
// modelWeights.json をロードして ModelV2 の重みに反映（キャッシュ付き）

import fs from 'fs';
import path from 'path';

export interface ModelWeights {
    form: number;            // 近走フォーム
    last3f: number;          // 上がり性能
    dist: number;            // 距離適性
    going: number;           // 重不適性
    styleScale: number;      // 脚質補正の全体スケール
    jockey: number;          // 騎手（外部orproxy）係数
    trainer: number;         // 調教師（外部orproxy）係数
    insideBiasScale: number; // insideBiasの効き
    frontBiasScale: number;  // frontBiasの効き
    paceScale: number;       // paceIndexの効き
}

export const DEFAULT_MODEL_WEIGHTS: ModelWeights = {
    form: 0.22,
    last3f: 0.18,
    dist: 0.14,
    going: 0.12,
    styleScale: 1.0,
    jockey: 0.06,
    trainer: 0.05,
    insideBiasScale: 1.0,
    frontBiasScale: 1.0,
    paceScale: 1.0,
};

type FileShape = { version?: number; weights?: Partial<ModelWeights> };

let cached: { mtimeMs: number; weights: ModelWeights } | null = null;

export function getWeightsPath(): string {
    const p = process.env.KEIBA_MODEL_WEIGHTS_PATH;
    if (p && p.trim().length > 0) return p;
    return path.join(process.cwd(), 'data', 'modelWeights.json');
}

function mergeWeights(base: ModelWeights, patch?: Partial<ModelWeights>): ModelWeights {
    return { ...base, ...(patch || {}) };
}

export function loadModelWeightsFromFile(): ModelWeights {
    const filePath = getWeightsPath();
    try {
        if (!fs.existsSync(filePath)) return DEFAULT_MODEL_WEIGHTS;
        const stat = fs.statSync(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs) return cached.weights;

        const raw = fs.readFileSync(filePath, 'utf-8');
        const json = JSON.parse(raw) as FileShape;
        const w = mergeWeights(DEFAULT_MODEL_WEIGHTS, json.weights);
        cached = { mtimeMs: stat.mtimeMs, weights: w };
        return w;
    } catch {
        return DEFAULT_MODEL_WEIGHTS;
    }
}

export function getModelWeights(overrides?: Partial<ModelWeights>): ModelWeights {
    const w = loadModelWeightsFromFile();
    return mergeWeights(w, overrides);
}

export function saveModelWeightsToFile(weights: ModelWeights, filePath?: string): void {
    const p = filePath || getWeightsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
        p,
        JSON.stringify({ version: 1, weights }, null, 2),
        'utf-8'
    );
    // キャッシュを更新
    try {
        const stat = fs.statSync(p);
        cached = { mtimeMs: stat.mtimeMs, weights };
    } catch {
        cached = { mtimeMs: Date.now(), weights };
    }
}
