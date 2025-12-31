// src/lib/analysis.ts
import { Race, Horse, BettingPortfolio, BettingTip, BetType } from './types';
import { estimateFinishProbs } from './simulator';

const sortByProb = (horses: Horse[]) => [...horses].sort((a, b) => b.estimatedProb - a.estimatedProb);
const sortByEv = (horses: Horse[]) => [...horses].sort((a, b) => (b.ev ?? -999) - (a.ev ?? -999));
const sortByUpset = (horses: Horse[]) => [...horses].sort((a, b) => (b.upsetIndex ?? 0) - (a.upsetIndex ?? 0));

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

function generatePortfolios(race: Race): BettingPortfolio[] {
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

    portfolios.push({ id: 'conservative', name: '🛡️ 堅実 (Conservative)', description: '資金防衛優先', tips: solidTips, riskLevel: 'Low' });

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

    portfolios.push({ id: 'balanced', name: '⚖️ バランス (Balanced)', description: '期待値×分散', tips: balancedTips, riskLevel: 'Medium' });

    // 3) 夢枠
    const dreamTips: BettingTip[] = [];
    const topUpset = sortedByUpset.find(h => (h.upsetIndex ?? 0) > 0) ?? sortedByProb[2];

    if (topUpset && favorite && secondFav && hasOddsForTip(race, '三連複', [topUpset.number, favorite.number, secondFav.number])) {
        dreamTips.push({ type: '三連複', selection: [topUpset.number, favorite.number, secondFav.number], confidence: 0.15, reason: '三連複オッズ取得済み。', alloc: 100 });
    } else if (topUpset && hasOddsForTip(race, '単勝', [topUpset.number])) {
        dreamTips.push({ type: '単勝', selection: [topUpset.number], confidence: 0.2, reason: '三連系取得不可のため穴単勝。', alloc: 100 });
    }

    portfolios.push({ id: 'dream', name: '🦄 夢枠 (Dream)', description: '一撃狙い（取得できた券種のみ）', tips: dreamTips, riskLevel: 'High' });

    return portfolios;
}

export function analyzeRace(race: Race): Race {
    const horses = race.horses;
    const notes: string[] = [];

    // marketProb: 全頭の単勝が揃った時のみ
    const allOddsAvailable = horses.every(h => h.odds != null && h.odds > 0);
    if (allOddsAvailable) {
        const sum = horses.reduce((acc, h) => acc + (1 / (h.odds as number)), 0);
        horses.forEach(h => { h.marketProb = (1 / (h.odds as number)) / sum; });
    } else {
        notes.push('単勝オッズが全頭揃っていないため、市場確率は取得不可');
        horses.forEach(h => { h.marketProb = null; });
    }

    // 推定確率
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

    // Monte Carlo for Top2/Top3
    const iterations = 20000;
    const modelWin = horses.map(h => h.estimatedProb);
    const modelProbs = estimateFinishProbs(modelWin, iterations, Math.random);
    horses.forEach((h, i) => {
        h.modelTop2Prob = modelProbs.top2[i];
        h.modelTop3Prob = modelProbs.top3[i];
    });

    // Market Monte Carlo (if available)
    if (allOddsAvailable) {
        const marketWin = horses.map(h => h.marketProb!);
        const marketProbs = estimateFinishProbs(marketWin, iterations, Math.random);
        horses.forEach((h, i) => {
            h.marketTop2Prob = marketProbs.top2[i];
            h.marketTop3Prob = marketProbs.top3[i];
        });
    }

    race.portfolios = generatePortfolios(race);
    race.analysis = {
        iterations,
        notes,
        marketAvailable: allOddsAvailable,
        modelAvailable: true,
    };

    return race;
}
