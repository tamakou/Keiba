// src/lib/optimizer.ts
import { BetType, BettingPortfolio, BettingTip, OddsEntry, Race } from './types';
import { BetEventProbs, FinishProbs } from './simulator';

export interface OptimizeSettings {
    budgetYen: number;     // 例: 20000（可変）
    maxBets: number;       // 例: 7
    dreamPct: number;      // 例: 0.03
    minUnitYen: number;    // 例: 100
}

type OptimizeProfile = 'conservative' | 'balanced' | 'dream';

type Candidate = {
    id: string;              // `${type}:${key}`
    type: BetType;
    selection: number[];
    key: string;

    prob: number;            // 0..1
    odds: number;            // >0
    ev: number;              // prob*odds-1

    includesAxis: boolean;   // 軸（推定勝率1位）を含むか
    isDream: boolean;        // 夢枠判定
};

function keyFor(type: BetType, selection: number[]): string {
    if (type === '単勝' || type === '複勝') return String(selection[0]);
    if (type === '馬単') return `${selection[0]}>${selection[1]}`;
    if (type === '三連単') return `${selection[0]}>${selection[1]}>${selection[2]}`;

    if (selection.length === 2) {
        const a = Math.min(selection[0], selection[1]);
        const b = Math.max(selection[0], selection[1]);
        return `${a}-${b}`;
    }
    if (selection.length === 3) {
        const s = [...selection].sort((x, y) => x - y);
        return `${s[0]}-${s[1]}-${s[2]}`;
    }
    return selection.join('-');
}

function parseSelectionFromKey(type: BetType, key: string): number[] | null {
    const k = key.trim().replace(/[→＞]/g, '>').replace(/[－–]/g, '-');

    if (type === '単勝' || type === '複勝') {
        const n = parseInt(k, 10);
        return Number.isFinite(n) ? [n] : null;
    }
    if (type === '馬単') {
        const p = k.split('>');
        if (p.length !== 2) return null;
        const a = parseInt(p[0], 10), b = parseInt(p[1], 10);
        return (Number.isFinite(a) && Number.isFinite(b)) ? [a, b] : null;
    }
    if (type === '三連単') {
        const p = k.split('>');
        if (p.length !== 3) return null;
        const a = parseInt(p[0], 10), b = parseInt(p[1], 10), c = parseInt(p[2], 10);
        return (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)) ? [a, b, c] : null;
    }
    // ワイド/馬連/三連複は "-" を想定
    const p = k.split('-');
    if (type === 'ワイド' || type === '馬連') {
        if (p.length !== 2) return null;
        const a = parseInt(p[0], 10), b = parseInt(p[1], 10);
        return (Number.isFinite(a) && Number.isFinite(b)) ? [a, b] : null;
    }
    if (type === '三連複') {
        if (p.length !== 3) return null;
        const a = parseInt(p[0], 10), b = parseInt(p[1], 10), c = parseInt(p[2], 10);
        return (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)) ? [a, b, c] : null;
    }
    return null;
}

function oddsFromEntry(type: BetType, e: OddsEntry): number | null {
    // 複勝はレンジがあり得るので下限(min)を採用（保守的）
    if (type === '複勝') return e.value ?? e.min ?? null;
    return e.value ?? null;
}

function clamp01(x: number): number {
    return Math.max(0, Math.min(1, x));
}

function normalizeToUnit(x: number, unit: number): number {
    return Math.floor(x / unit) * unit;
}

function dreamBudgetYen(settings: OptimizeSettings): number {
    return normalizeToUnit(settings.budgetYen * settings.dreamPct, settings.minUnitYen);
}

function isDreamCandidate(type: BetType, odds: number): boolean {
    // 夢枠：基本は三連単。加えて超高配当の三連複を夢枠扱いにする
    if (type === '三連単') return true;
    if (type === '三連複' && odds >= 80) return true;
    return false;
}

function scoreCandidate(c: Candidate, profile: OptimizeProfile): number {
    // スコア = 選抜用（最適化の目的関数）
    const p = c.prob;
    const ev = c.ev;
    const o = c.odds;

    if (profile === 'conservative') {
        // 的中寄り + 少しEV
        return (1.0 * p) + (0.35 * ev) - (o >= 50 ? 0.10 : 0);
    }
    if (profile === 'balanced') {
        // EV寄り
        return (1.0 * ev) + (0.20 * p);
    }
    // dream
    return (1.15 * ev) + (0.05 * p) + (0.03 * Math.log(Math.max(1.01, o)));
}

function allocByWeights(total: number, unit: number, weights: number[]): number[] {
    const n = weights.length;
    if (n === 0) return [];

    // 各ベット最低 unit
    const minTotal = n * unit;
    const out = Array(n).fill(unit);

    if (total <= minTotal) {
        // 予算が足りない/ギリギリ→先頭に寄せる
        out.fill(0);
        out[0] = normalizeToUnit(total, unit);
        return out;
    }

    let remain = total - minTotal;

    const w = weights.map(x => Math.max(0, x));
    const sumW = w.reduce((a, b) => a + b, 0);
    if (sumW <= 0) {
        const addEach = normalizeToUnit(remain / n, unit);
        for (let i = 0; i < n; i++) out[i] += addEach;
        remain -= addEach * n;
        let i = 0;
        while (remain >= unit) { out[i] += unit; remain -= unit; i = (i + 1) % n; }
        return out;
    }

    // 比例配分（unit丸め）
    const raw = w.map(x => x / sumW);
    const add = raw.map(r => normalizeToUnit(r * remain, unit));
    let used = add.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) out[i] += add[i];

    // 端数は分数の大きい順に配る
    let left = remain - used;
    const frac = raw.map((r, i) => ({ i, frac: (r * remain) - add[i] }));
    frac.sort((a, b) => b.frac - a.frac);
    let p = 0;
    while (left >= unit) {
        out[frac[p].i] += unit;
        left -= unit;
        p = (p + 1) % frac.length;
    }
    return out;
}

function buildCandidates(params: {
    race: Race;
    modelWin: number[];
    modelProbs: FinishProbs;
    betEvents: BetEventProbs;
    kPlace: number;
    axis: number;
}): { candidates: Candidate[]; placeProbByNum: Record<number, number> } {
    const { race, modelProbs, betEvents, kPlace, axis } = params;

    const placeProbByNum: Record<number, number> = {};
    race.horses.forEach((h, i) => {
        const pPlace = (kPlace === 1) ? modelProbs.win[i] : (kPlace === 2) ? modelProbs.top2[i] : modelProbs.top3[i];
        placeProbByNum[h.number] = pPlace;
    });

    const candidates: Candidate[] = [];

    const add = (type: BetType, selection: number[], prob: number | null | undefined, odds: number | null | undefined) => {
        if (prob == null || odds == null) return;
        if (!(prob > 0) || !(odds > 0)) return;

        const key = keyFor(type, selection);
        const ev = (prob * odds) - 1;
        const includesAxis = selection.includes(axis);
        const isDream = isDreamCandidate(type, odds);

        candidates.push({
            id: `${type}:${key}`,
            type,
            selection,
            key,
            prob: clamp01(prob),
            odds,
            ev,
            includesAxis,
            isDream,
        });
    };

    // 単勝：horse.odds
    race.horses.forEach((h, i) => add('単勝', [h.number], race.horses[i].estimatedProb, h.odds));

    // 複勝：oddsTables['複勝']があれば
    const placeTable = race.oddsTables?.['複勝'];
    if (placeTable) {
        for (const [k, e] of Object.entries(placeTable.odds)) {
            const sel = parseSelectionFromKey('複勝', k);
            if (!sel) continue;
            const odds = oddsFromEntry('複勝', e);
            const prob = placeProbByNum[sel[0]];
            add('複勝', sel, prob, odds);
        }
    }

    const probByKey = (type: BetType, key: string): number | null => {
        if (type === 'ワイド') return betEvents.wideTopK[key] ?? null;
        if (type === '馬連') return betEvents.umaren[key] ?? null;
        if (type === '三連複') return betEvents.sanrenpuku[key] ?? null;
        if (type === '馬単') return betEvents.umatan[key] ?? null;
        if (type === '三連単') return betEvents.sanrentan[key] ?? null;
        return null;
    };

    const addFromTable = (type: BetType) => {
        const tbl = race.oddsTables?.[type];
        if (!tbl) return;
        for (const [k, e] of Object.entries(tbl.odds)) {
            const sel = parseSelectionFromKey(type, k);
            if (!sel) continue;
            const key = keyFor(type, sel);
            const prob = probByKey(type, key);
            const odds = oddsFromEntry(type, e);
            add(type, sel, prob, odds);
        }
    };

    addFromTable('ワイド');
    addFromTable('馬連');
    addFromTable('三連複');
    addFromTable('三連単');
    addFromTable('馬単');

    return { candidates, placeProbByNum };
}

function capCandidatesByType(cands: Candidate[], type: BetType, topEv: number, topProb: number, profile: OptimizeProfile): Candidate[] {
    const same = cands.filter(c => c.type === type);
    if (same.length === 0) return [];

    const byEv = [...same].sort((a, b) => b.ev - a.ev).slice(0, topEv);
    const byProb = [...same].sort((a, b) => b.prob - a.prob).slice(0, topProb);
    const byScore = [...same].sort((a, b) => scoreCandidate(b, profile) - scoreCandidate(a, profile)).slice(0, Math.max(topEv, topProb));

    const m = new Map<string, Candidate>();
    for (const c of [...byEv, ...byProb, ...byScore]) m.set(c.id, c);
    return [...m.values()];
}

type State = {
    selected: Candidate[];
    used: Set<string>;
    score: number;
    hasSurvival: boolean;
    dreamCount: number;
    typeCount: Partial<Record<BetType, number>>;
};

function selectCandidates(
    profile: OptimizeProfile,
    candidates: Candidate[],
    axis: number,
    settings: OptimizeSettings
): { selected: Candidate[]; notes: string[] } {
    const notes: string[] = [];

    const unit = settings.minUnitYen;
    const effMaxBets = Math.max(1, Math.min(settings.maxBets, Math.floor(settings.budgetYen / unit)));
    const dBudget = dreamBudgetYen(settings);

    const dreamLimit = (profile === 'dream' && dBudget >= unit) ? 1 : 0;

    const typeLimit: Partial<Record<BetType, number>> = {
        '単勝': 2,
        '複勝': 2,
        'ワイド': 3,
        '馬連': 2,
        '馬単': 1,
        '三連複': 2,
        '三連単': 1,
    };

    // プロファイルごとに候補を絞る（大量生成→上位集合で探索）
    const pool: Candidate[] = [
        ...capCandidatesByType(candidates, '単勝', 25, 10, profile),
        ...capCandidatesByType(candidates, '複勝', 25, 10, profile),
        ...capCandidatesByType(candidates, 'ワイド', 60, 15, profile),
        ...capCandidatesByType(candidates, '馬連', 60, 15, profile),
        ...capCandidatesByType(candidates, '三連複', 120, 20, profile),
        ...capCandidatesByType(candidates, '三連単', 80, 10, profile),
        ...capCandidatesByType(candidates, '馬単', 60, 10, profile),
    ].sort((a, b) => scoreCandidate(b, profile) - scoreCandidate(a, profile));

    const minEvConservative = Number(process.env.KEIBA_MIN_EV_CONSERVATIVE ?? '-0.03'); // 保険を少し許す
    const minEvBalanced = Number(process.env.KEIBA_MIN_EV_BALANCED ?? '0.00');     // 原則プラスEVのみ
    const minEvDream = Number(process.env.KEIBA_MIN_EV_DREAM ?? '0.00');        // 夢枠も原則プラス

    const minEv =
        profile === 'conservative' ? minEvConservative :
            profile === 'balanced' ? minEvBalanced :
                minEvDream;

    // 軸飛び生存券は“ややマイナス”を許す（ただし深いマイナスは切る）
    const survivalMaxNeg = Number(process.env.KEIBA_SURVIVAL_MAX_NEG ?? '-0.06');

    const pool2 = pool.filter(c => {
        if (c.ev >= minEv) return true;
        if (!c.includesAxis && c.ev >= survivalMaxNeg) return true;
        return false;
    });

    let finalPool = pool2;
    if (pool2.length === 0) {
        notes.push(`EVフィルタが厳しすぎるため無効化（minEv=${minEv}, survivalMaxNeg=${survivalMaxNeg}）`);
        finalPool = pool;
    } else if (pool2.length !== pool.length) {
        notes.push(`EVフィルタ適用: ${pool.length}→${pool2.length}（minEv=${minEv}, survivalMaxNeg=${survivalMaxNeg}）`);
    }

    if (finalPool.length === 0) {
        notes.push('候補買い目が生成できませんでした（oddsTables不足 or Monte Carloで確率が付与できない可能性）');
        return { selected: [], notes };
    }

    const beamWidth = 200;
    let beam: State[] = [{
        selected: [],
        used: new Set<string>(),
        score: 0,
        hasSurvival: false,
        dreamCount: 0,
        typeCount: {},
    }];

    const canAdd = (st: State, c: Candidate) => {
        if (st.used.has(c.id)) return false;
        if (c.isDream && st.dreamCount >= dreamLimit) return false;

        const lim = typeLimit[c.type] ?? effMaxBets;
        const cnt = st.typeCount[c.type] ?? 0;
        if (cnt >= lim) return false;

        return true;
    };

    for (let step = 0; step < effMaxBets; step++) {
        const next: State[] = [...beam]; // "ここで止める"も許す

        for (const st of beam) {
            // 上位から一定数だけ展開して速度確保
            const expandCap = 120;
            for (let i = 0; i < Math.min(finalPool.length, expandCap); i++) {
                const c = finalPool[i];
                if (!canAdd(st, c)) continue;

                const nst: State = {
                    selected: [...st.selected, c],
                    used: new Set(st.used),
                    score: st.score + scoreCandidate(c, profile),
                    hasSurvival: st.hasSurvival || !c.includesAxis,
                    dreamCount: st.dreamCount + (c.isDream ? 1 : 0),
                    typeCount: { ...st.typeCount },
                };
                nst.used.add(c.id);
                nst.typeCount[c.type] = (nst.typeCount[c.type] ?? 0) + 1;

                next.push(nst);
            }
        }

        next.sort((a, b) => b.score - a.score);
        beam = next.slice(0, beamWidth);
    }

    // 夢枠プロファイルは dreamが入っているものを優先
    const wantDream = (profile === 'dream' && dBudget >= unit);
    let best: State | null = null;

    for (const st of beam) {
        if (st.selected.length === 0) continue;
        if (!st.hasSurvival) continue; // 軸飛び生存券必須
        if (wantDream && st.dreamCount < 1) continue;
        best = st;
        break;
    }

    // 生存券条件を満たすものがない場合は、条件を緩めて採用
    if (!best) {
        notes.push('制約（軸飛び生存券/夢枠）を満たす解が見つからず、一部制約を緩和しました。');
        best = beam.find(st => st.selected.length > 0) ?? beam[0];
    }

    let selected = best.selected.slice(0, effMaxBets);

    // 念のため：非軸が1つもない場合は非軸を強制で入れる
    if (!selected.some(c => !c.includesAxis)) {
        const alt = finalPool.find(c => !c.includesAxis && !c.isDream);
        if (alt) {
            selected[selected.length - 1] = alt;
        } else {
            notes.push('軸を含まない買い目候補が見つからず、生存券制約を厳密に満たせませんでした。');
        }
    }

    return { selected, notes };
}

function allocateStakes(
    profile: OptimizeProfile,
    selected: Candidate[],
    settings: OptimizeSettings
): BettingTip[] {
    const unit = settings.minUnitYen;
    const budget = normalizeToUnit(settings.budgetYen, unit);

    // 夢枠は上限 dreamPct
    const dCap = dreamBudgetYen(settings);

    // dream候補（最大1想定）
    const dream = selected.filter(c => c.isDream);
    const regular = selected.filter(c => !c.isDream);

    const dreamStake = (dream.length > 0) ? Math.min(dCap, budget) : 0;
    const regularBudget = budget - dreamStake;

    // regular配分重み
    const weight = (c: Candidate): number => {
        if (profile === 'conservative') return c.prob + Math.max(0, c.ev) * 0.2;
        if (profile === 'balanced') return Math.max(0, c.ev) + 0.05;
        return (Math.max(0, c.ev) + 0.03) * Math.log(Math.max(1.01, c.odds));
    };

    // regular stakes
    const regWeights = regular.map(weight);
    const regStakes = allocByWeights(regularBudget, unit, regWeights);

    const tips: BettingTip[] = [];

    // survivalラベル：軸を含まない買い目を1つは明示
    const survivalId = regular.find(c => !c.includesAxis)?.id ?? selected.find(c => !c.includesAxis)?.id;

    regular.forEach((c, i) => {
        const stakeYen = regStakes[i] ?? 0;
        const alloc = budget > 0 ? Math.round((stakeYen / budget) * 100) : undefined;

        const isSurvival = (c.id === survivalId);
        tips.push({
            type: c.type,
            selection: c.selection,
            confidence: clamp01(Math.min(0.9, Math.max(0.1, c.prob * 2))),
            reason: `${isSurvival ? '【軸飛び生存券】' : ''}${profile === 'balanced' ? 'EV重視' : profile === 'conservative' ? '的中×EV' : '高配当寄り'}（最適化選抜）`,
            stakeYen,
            alloc,
            odds: c.odds,
            prob: c.prob,
            ev: c.ev,
        });
    });

    if (dream.length > 0 && dreamStake >= unit) {
        const c = dream[0];
        tips.push({
            type: c.type,
            selection: c.selection,
            confidence: clamp01(Math.min(0.5, Math.max(0.05, c.prob * 2))),
            reason: `【夢枠】上限${dreamStake.toLocaleString()}円（最適化選抜）`,
            stakeYen: dreamStake,
            alloc: budget > 0 ? Math.round((dreamStake / budget) * 100) : undefined,
            odds: c.odds,
            prob: c.prob,
            ev: c.ev,
        });
    }

    // 7点以内に安全トリム（通常不要）
    tips.sort((a, b) => (b.ev ?? -999) - (a.ev ?? -999));
    return tips.slice(0, settings.maxBets);
}

export function buildOptimizedPortfolios(params: {
    race: Race;
    modelWin: number[];
    modelProbs: FinishProbs;
    betEvents: BetEventProbs;
    kPlace: number;
    settings: OptimizeSettings;
}): { portfolios: BettingPortfolio[]; notes: string[] } {
    const { race, modelWin, modelProbs, betEvents, kPlace, settings } = params;
    const notes: string[] = [];

    const unit = settings.minUnitYen;
    const budget = normalizeToUnit(settings.budgetYen, unit);
    if (budget < unit) {
        notes.push(`budgetYen=${settings.budgetYen} が小さすぎます（最低${unit}円単位）。`);
        return { portfolios: [], notes };
    }

    // 軸＝推定勝率1位
    const axis = [...race.horses].sort((a, b) => b.estimatedProb - a.estimatedProb)[0]?.number ?? 0;

    const built = buildCandidates({ race, modelWin, modelProbs, betEvents, kPlace, axis });
    const candidates = built.candidates;

    notes.push(`最適化設定: budget=${budget.toLocaleString()}円, maxBets=${settings.maxBets}, dreamCap=${dreamBudgetYen(settings).toLocaleString()}円, unit=${unit}円, axis=#${axis}`);

    if (candidates.length === 0) {
        notes.push('候補買い目が0件（オッズ or Monte Carlo確率が不足）');
        return { portfolios: [], notes };
    }

    const profiles: { id: OptimizeProfile; pf: BettingPortfolio }[] = [
        {
            id: 'conservative',
            pf: {
                id: 'conservative',
                name: '🛡️ 堅実（最適化）',
                description: '的中×資金残しを優先（7点以内/夢枠は上限内）',
                scenario: '順当〜やや波乱でも耐えやすい組み合わせ',
                tips: [],
                riskLevel: 'Low',
            },
        },
        {
            id: 'balanced',
            pf: {
                id: 'balanced',
                name: '⚖️ バランス（最適化）',
                description: 'EVを優先しつつ、軸飛びにも備える',
                scenario: 'EV上位が1つ勝ち切る／連系で回収',
                tips: [],
                riskLevel: 'Medium',
            },
        },
        {
            id: 'dream',
            pf: {
                id: 'dream',
                name: '🦄 夢枠（最適化）',
                description: '高配当寄り。ただし夢枠は予算の3%以内',
                scenario: '三連系が刺さる想定（ただし小額）',
                tips: [],
                riskLevel: 'High',
            },
        },
    ];

    const portfolios: BettingPortfolio[] = [];

    for (const p of profiles) {
        const sel = selectCandidates(p.id, candidates, axis, settings);
        notes.push(...sel.notes.map(x => `${p.pf.name}: ${x}`));

        const tips = allocateStakes(p.id, sel.selected, settings);

        // 合計を予算に合わせる（端数を最初の非夢枠へ）
        const sum = tips.reduce((a, t) => a + (t.stakeYen ?? 0), 0);
        const diff = budget - sum;
        if (diff !== 0) {
            const target = tips.find(t => !(t.reason ?? '').includes('【夢枠】')) ?? tips[0];
            if (target) {
                target.stakeYen = (target.stakeYen ?? 0) + diff;
                if (budget > 0) target.alloc = Math.round(((target.stakeYen ?? 0) / budget) * 100);
            }
        }

        p.pf.tips = tips;
        portfolios.push(p.pf);
    }

    return { portfolios, notes };
}
