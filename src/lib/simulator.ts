// src/lib/simulator.ts

export interface FinishProbs {
    win: number[];
    top2: number[];
    top3: number[];
}

export interface BetEventProbs {
    wideTopK: Record<string, number>;     // ワイド（両方複勝圏TopK）
    umaren: Record<string, number>;       // 馬連（1-2着どちらでも）
    sanrenpuku: Record<string, number>;   // 三連複（1-3着どれでも）
    umatan: Record<string, number>;       // 馬単（1>2）
    sanrentan: Record<string, number>;    // 三連単（1>2>3）
}

function weightedPickIndex(weights: number[], rng: () => number): number {
    let sum = 0;
    for (const w of weights) sum += w;
    if (sum <= 0) return -1;

    const r = rng() * sum;
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
        acc += weights[i];
        if (r <= acc) return i;
    }
    return weights.length - 1;
}

// Plackett–Luce: 重みに比例して着順を抽選
export function sampleOrderPlackettLuce(weights: number[], rng: () => number): number[] {
    const n = weights.length;
    const alive = Array.from({ length: n }, (_, i) => i);
    const w = weights.slice();
    const order: number[] = [];

    for (let pos = 0; pos < n; pos++) {
        const idxInAlive = weightedPickIndex(alive.map(i => Math.max(0, w[i])), rng);
        if (idxInAlive < 0) break;
        const picked = alive[idxInAlive];
        order.push(picked);
        alive.splice(idxInAlive, 1);
    }

    for (const i of alive) order.push(i);
    return order;
}

export function estimateFinishProbs(weights: number[], iterations: number, rng: () => number): FinishProbs {
    const n = weights.length;
    const win = Array(n).fill(0);
    const top2 = Array(n).fill(0);
    const top3 = Array(n).fill(0);

    for (let t = 0; t < iterations; t++) {
        const order = sampleOrderPlackettLuce(weights, rng);
        if (order.length > 0) win[order[0]] += 1;

        if (order.length > 0) top2[order[0]] += 1;
        if (order.length > 1) top2[order[1]] += 1;

        if (order.length > 0) top3[order[0]] += 1;
        if (order.length > 1) top3[order[1]] += 1;
        if (order.length > 2) top3[order[2]] += 1;
    }

    for (let i = 0; i < n; i++) {
        win[i] /= iterations;
        top2[i] /= iterations;
        top3[i] /= iterations;
    }

    return { win, top2, top3 };
}

function key2(a: number, b: number): string {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
}
function key3(a: number, b: number, c: number): string {
    const arr = [a, b, c].sort((x, y) => x - y);
    return `${arr[0]}-${arr[1]}-${arr[2]}`;
}
function key2o(a: number, b: number): string {
    return `${a}>${b}`;
}
function key3o(a: number, b: number, c: number): string {
    return `${a}>${b}>${c}`;
}

export function estimateBetEventProbs(
    weights: number[],
    iterations: number,
    topKForPlace: number,
    horseNumbers: number[],
    rng: () => number
): BetEventProbs {
    const wideTopK: Record<string, number> = {};
    const umaren: Record<string, number> = {};
    const sanrenpuku: Record<string, number> = {};
    const umatan: Record<string, number> = {};
    const sanrentan: Record<string, number> = {};

    for (let t = 0; t < iterations; t++) {
        const order = sampleOrderPlackettLuce(weights, rng);

        // ワイド（複勝圏TopK）
        const placed = order.slice(0, topKForPlace).map(i => horseNumbers[i]);
        for (let i = 0; i < placed.length; i++) {
            for (let j = i + 1; j < placed.length; j++) {
                const k = key2(placed[i], placed[j]);
                wideTopK[k] = (wideTopK[k] || 0) + 1;
            }
        }

        // 1-2着
        if (order.length >= 2) {
            const a = horseNumbers[order[0]];
            const b = horseNumbers[order[1]];
            umaren[key2(a, b)] = (umaren[key2(a, b)] || 0) + 1;
            umatan[key2o(a, b)] = (umatan[key2o(a, b)] || 0) + 1;
        }

        // 1-3着
        if (order.length >= 3) {
            const a = horseNumbers[order[0]];
            const b = horseNumbers[order[1]];
            const c = horseNumbers[order[2]];
            sanrenpuku[key3(a, b, c)] = (sanrenpuku[key3(a, b, c)] || 0) + 1;
            sanrentan[key3o(a, b, c)] = (sanrentan[key3o(a, b, c)] || 0) + 1;
        }
    }

    for (const k of Object.keys(wideTopK)) wideTopK[k] /= iterations;
    for (const k of Object.keys(umaren)) umaren[k] /= iterations;
    for (const k of Object.keys(sanrenpuku)) sanrenpuku[k] /= iterations;
    for (const k of Object.keys(umatan)) umatan[k] /= iterations;
    for (const k of Object.keys(sanrentan)) sanrentan[k] /= iterations;

    return { wideTopK, umaren, sanrenpuku, umatan, sanrentan };
}
