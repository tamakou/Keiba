// src/lib/analysis.ts
import { Race, Horse, BettingPortfolio, BettingTip, BetType } from './types';
import { estimateFinishProbs, estimateBetEventProbs, FinishProbs, BetEventProbs } from './simulator';
import { buildOptimizedPortfolios, OptimizeSettings } from './optimizer';

export interface AnalyzeOptions {
    budgetYen?: number;   // 可変
    maxBets?: number;     // default 7
    dreamPct?: number;    // default 0.03
    minUnitYen?: number;  // default 100
    enableOptimization?: boolean; // default true
}

const sortByProb = (horses: Horse[]) => [...horses].sort((a, b) => b.estimatedProb - a.estimatedProb);
const sortByEv = (horses: Horse[]) => [...horses].sort((a, b) => (b.ev ?? -999) - (a.ev ?? -999));
const sortByUpset = (horses: Horse[]) => [...horses].sort((a, b) => (b.upsetIndex ?? 0) - (a.upsetIndex ?? 0));

function topKForPlace(n: number): number {
    if (n <= 4) return 1;
    if (n <= 7) return 2;
    return 3;
}

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

function hasOddsForTip(race: Race, type: BetType, selection: number[]): boolean {
    if (type === '単勝') {
        const h = race.horses.find(x => x.number === selection[0]);
        return !!(h && h.odds != null && h.odds > 0);
    }
    const table = race.oddsTables?.[type];
    if (!table) return false;
    const key = keyFor(type, selection);
    const e = table.odds[key];
    return !!(e && (e.value != null || e.min != null));
}

function getOddsForTip(race: Race, type: BetType, selection: number[]): number | null {
    if (type === '単勝') {
        const h = race.horses.find(x => x.number === selection[0]);
        return h?.odds ?? null;
    }
    const table = race.oddsTables?.[type];
    if (!table) return null;
    const key = keyFor(type, selection);
    const e = table.odds[key];
    if (!e) return null;
    if (type === '複勝') return e.value ?? e.min ?? null;
    return e.value ?? null;
}

function calcEv(prob: number | null, odds: number | null): number | null {
    if (prob == null || odds == null || odds <= 0) return null;
    return prob * odds - 1;
}

// フォールバック用：従来ポートフォリオ（ただし三連系は"テーブルから選ぶ"）
function generatePortfoliosFallback(race: Race): BettingPortfolio[] {
    const horses = race.horses;
    if (horses.length === 0) return [];

    const sortedByProb = sortByProb(horses);
    const sortedByEv = sortByEv(horses);
    const sortedByUpset = sortByUpset(horses);

    const favorite = sortedByProb[0];
    const secondFav = sortedByProb[1];

    const portfolios: BettingPortfolio[] = [];

    // 1) 堅実
    const solidTips: BettingTip[] = [];
    if (hasOddsForTip(race, '複勝', [favorite.number])) {
        solidTips.push({ type: '複勝', selection: [favorite.number], confidence: 0.9, reason: '的中率重視。複勝オッズ取得済み。', alloc: 50 });
    } else {
        solidTips.push({ type: '単勝', selection: [favorite.number], confidence: 0.6, reason: '複勝オッズ取得不可のため、単勝に置換。', alloc: 50 });
    }
    if (favorite && secondFav && hasOddsForTip(race, 'ワイド', [favorite.number, secondFav.number])) {
        solidTips.push({ type: 'ワイド', selection: [favorite.number, secondFav.number], confidence: 0.8, reason: '上位2頭の安定決着（ワイドオッズ取得済み）。', alloc: 50 });
    }
    portfolios.push({ id: 'conservative', name: '🛡️ 堅実 (Fallback)', description: '資金防衛優先', tips: solidTips, riskLevel: 'Low' });

    // 2) バランス
    const balancedTips: BettingTip[] = [];
    const highEvHorses = sortedByEv.filter(h => (h.ev ?? -999) > 0).slice(0, 3);
    if (highEvHorses.length > 0) {
        const bestEv = highEvHorses[0];
        balancedTips.push({ type: '単勝', selection: [bestEv.number], confidence: 0.7, reason: `期待値上位（単勝）。`, alloc: 60 });

        const evSecond = highEvHorses[1] ?? secondFav;
        if (evSecond && hasOddsForTip(race, '馬連', [bestEv.number, evSecond.number])) {
            balancedTips.push({ type: '馬連', selection: [bestEv.number, evSecond.number], confidence: 0.6, reason: '馬連オッズ取得済み。', alloc: 40 });
        } else if (evSecond && hasOddsForTip(race, 'ワイド', [bestEv.number, evSecond.number])) {
            balancedTips.push({ type: 'ワイド', selection: [bestEv.number, evSecond.number], confidence: 0.7, reason: '馬連取得不可のためワイドに置換。', alloc: 40 });
        }
    } else {
        balancedTips.push({ type: '単勝', selection: [favorite.number], confidence: 0.6, reason: 'EV優位が不明なため本命単勝。', alloc: 100 });
    }
    portfolios.push({ id: 'balanced', name: '⚖️ バランス (Fallback)', description: '期待値×分散', tips: balancedTips, riskLevel: 'Medium' });

    // 3) 夢枠（ここが重要：特定1組ではなく「テーブル内から選ぶ」）
    const dreamTips: BettingTip[] = [];
    const trioTable = race.oddsTables?.['三連複'];
    const keys = trioTable ? Object.keys(trioTable.odds) : [];

    if (keys.length > 0) {
        // 本命・対抗を含む三連複を優先
        const fav = String(favorite.number);
        const sec = String(secondFav.number);
        const pick =
            keys.find(k => k.split('-').includes(fav) && k.split('-').includes(sec)) ||
            keys[0];

        const sel = pick.split('-').map(n => parseInt(n, 10)).filter(n => Number.isFinite(n));
        if (sel.length === 3) {
            dreamTips.push({ type: '三連複', selection: sel, confidence: 0.15, reason: '三連複オッズ取得済み（一覧から選択）。', alloc: 100 });
        }
    } else {
        const topUpset = sortedByUpset.find(h => (h.upsetIndex ?? 0) > 0) ?? sortedByProb[2];
        const note = trioTable?.note ? `（${trioTable.note}）` : '';
        if (topUpset && hasOddsForTip(race, '単勝', [topUpset.number])) {
            dreamTips.push({ type: '単勝', selection: [topUpset.number], confidence: 0.2, reason: `三連複が取得不可のため穴単勝${note}`, alloc: 100 });
        }
    }
    portfolios.push({ id: 'dream', name: '🦄 夢枠 (Fallback)', description: '一撃狙い（取得できた券種のみ）', tips: dreamTips, riskLevel: 'High' });

    return portfolios;
}

export function analyzeRace(race: Race, opts: AnalyzeOptions = {}): Race {
    const horses = race.horses;
    const notes: string[] = [];

    // オッズテーブルの状態を notes に出す（「取得成功だが空」切り分け）
    const checkTypes: BetType[] = ['複勝', 'ワイド', '馬連', '三連複', '三連単', '馬単'];
    for (const t of checkTypes) {
        const tbl = race.oddsTables?.[t];
        if (!tbl) continue;
        const count = Object.keys(tbl.odds ?? {}).length;
        if (count === 0) {
            notes.push(`${t}: 取得はできたがパース結果が空の可能性（note=${tbl.note ?? 'なし'}）`);
        } else {
            notes.push(`${t}: ${count}件のオッズを取得`);
        }
    }

    // marketProb（全頭単勝オッズ揃った時のみ）
    const allOddsAvailable = horses.every(h => h.odds != null && h.odds > 0);
    if (allOddsAvailable) {
        const sum = horses.reduce((acc, h) => acc + (1 / (h.odds as number)), 0);
        horses.forEach(h => { h.marketProb = (1 / (h.odds as number)) / sum; });
    } else {
        notes.push('単勝オッズが全頭揃っていないため、市場確率は取得不可');
        horses.forEach(h => { h.marketProb = null; });
    }

    // 推定確率（現状ロジック）
    let sumScore = 0;
    const equalProb = horses.length ? 1 / horses.length : 0;

    horses.forEach(h => {
        const baseScore = (h.odds != null && h.odds > 0) ? (100 / h.odds) : 10;
        let multiplier = 1.0;
        const factors: string[] = [];

        if (h.gate > 0 && h.gate <= 2) { multiplier += 0.05; factors.push('好枠(内)'); }
        else if (h.gate >= 7 && horses.length > 10) { multiplier -= 0.03; factors.push('外枠'); }

        if (h.weightChange != null) {
            if (Math.abs(h.weightChange) <= 2) { multiplier += 0.02; factors.push('馬体安定'); }
            else if (h.weightChange >= 10) { multiplier -= 0.1; factors.push(`馬体増+${h.weightChange}kg`); }
            else if (h.weightChange <= -10) { multiplier -= 0.1; factors.push(`馬体減${h.weightChange}kg`); }
        } else {
            factors.push('馬体増減:取得不可');
        }

        const topJockeys = ['御神本', '笹川翼', '矢野', '本田正', 'ルメール', '川田', 'デムーロ', '森泰斗'];
        if (h.jockey !== '取得不可' && topJockeys.some(j => h.jockey.includes(j))) { multiplier += 0.1; factors.push('有力騎手'); }

        const o = h.odds ?? 0;
        let upsetIndex = 0;
        if (o >= 50) { upsetIndex = 0.8; factors.push('大穴候補 ★★★'); }
        else if (o >= 30) { upsetIndex = 0.5; factors.push('穴馬候補 ★★'); }
        else if (o >= 15) { upsetIndex = 0.3; factors.push('中穴 ★'); }
        h.upsetIndex = upsetIndex;

        h.estimatedProb = baseScore * multiplier;
        h.factors = factors.slice(0, 3);
        sumScore += h.estimatedProb;
    });

    horses.forEach(h => {
        h.estimatedProb = sumScore > 0 ? (h.estimatedProb / sumScore) : equalProb;
        h.ev = (h.odds != null && h.odds > 0) ? (h.estimatedProb * h.odds - 1) : null;
    });

    // Monte Carlo（Top2/Top3）
    const iterations = 20000;
    const modelWin = horses.map(h => h.estimatedProb);
    const modelProbs = estimateFinishProbs(modelWin, iterations, Math.random);

    horses.forEach((h, i) => {
        h.modelTop2Prob = modelProbs.top2[i];
        h.modelTop3Prob = modelProbs.top3[i];
    });

    if (allOddsAvailable) {
        const marketWin = horses.map(h => h.marketProb!);
        const marketProbs = estimateFinishProbs(marketWin, iterations, Math.random);
        horses.forEach((h, i) => {
            h.marketTop2Prob = marketProbs.top2[i];
            h.marketTop3Prob = marketProbs.top3[i];
        });
    }

    // 券種イベント確率
    const kPlace = topKForPlace(horses.length);
    const horseNumbers = horses.map(h => h.number);
    const betEvents = estimateBetEventProbs(modelWin, iterations, kPlace, horseNumbers, Math.random);

    // --- ここから最適化 ---
    const enableOptimization = opts.enableOptimization ?? true;
    const budgetYen = Number.isFinite(opts.budgetYen ?? NaN) && (opts.budgetYen as number) > 0 ? (opts.budgetYen as number) : 20000;
    const maxBets = Number.isFinite(opts.maxBets ?? NaN) && (opts.maxBets as number) > 0 ? (opts.maxBets as number) : 7;
    const dreamPct = Number.isFinite(opts.dreamPct ?? NaN) && (opts.dreamPct as number) >= 0 ? (opts.dreamPct as number) : 0.03;
    const minUnitYen = Number.isFinite(opts.minUnitYen ?? NaN) && (opts.minUnitYen as number) > 0 ? (opts.minUnitYen as number) : 100;

    if (opts.budgetYen == null) {
        notes.push('budgetYen未指定のため、参考として20,000円で配分（?budgetYen=... で変更可）');
    }

    if (enableOptimization) {
        const settings: OptimizeSettings = { budgetYen, maxBets, dreamPct, minUnitYen };

        const opt = buildOptimizedPortfolios({
            race,
            modelWin,
            modelProbs,
            betEvents,
            kPlace,
            settings,
        });

        if (opt.portfolios.length > 0) {
            race.portfolios = opt.portfolios;
            notes.push(...opt.notes);
        } else {
            notes.push(...opt.notes);
            race.portfolios = generatePortfoliosFallback(race);
        }
    } else {
        race.portfolios = generatePortfoliosFallback(race);
    }

    // Tipに prob/odds/ev を付与（既存UI互換）
    const placeProbByNum: Record<number, number> = {};
    horses.forEach((h, i) => {
        const pPlace = (kPlace === 1) ? modelProbs.win[i] : (kPlace === 2) ? modelProbs.top2[i] : modelProbs.top3[i];
        placeProbByNum[h.number] = pPlace;
    });

    const probForTip = (type: BetType, sel: number[]): number | null => {
        if (type === '単勝') {
            const h = horses.find(x => x.number === sel[0]);
            return h ? h.estimatedProb : null;
        }
        if (type === '複勝') return placeProbByNum[sel[0]] ?? null;

        const key = keyFor(type, sel);
        if (type === 'ワイド') return betEvents.wideTopK[key] ?? null;
        if (type === '馬連') return betEvents.umaren[key] ?? null;
        if (type === '三連複') return betEvents.sanrenpuku[key] ?? null;
        if (type === '馬単') return betEvents.umatan[key] ?? null;
        if (type === '三連単') return betEvents.sanrentan[key] ?? null;
        return null;
    };

    if (race.portfolios) {
        race.portfolios.forEach(pf => {
            pf.tips.forEach(tip => {
                // 最適化済みの場合は既に値があるのでスキップ
                if (tip.prob == null) {
                    tip.prob = probForTip(tip.type, tip.selection);
                }
                if (tip.odds == null) {
                    tip.odds = getOddsForTip(race, tip.type, tip.selection);
                }
                if (tip.ev == null) {
                    tip.ev = calcEv(tip.prob, tip.odds);
                }

                if (tip.type === '複勝' && tip.odds != null) {
                    tip.reason += `（EV計算は複勝オッズ下限=${tip.odds}を使用）`;
                }
            });

            const missing = pf.tips.filter(t => t.ev == null);
            if (missing.length > 0) {
                notes.push(`${pf.name}: 一部買い目でEV算出不可（オッズor確率が取得不可）`);
            }
        });
    }

    race.analysis = {
        iterations,
        notes,
        marketAvailable: allOddsAvailable,
        modelAvailable: true,
    };

    return race;
}
