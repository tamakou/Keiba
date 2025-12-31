import { Race, Horse, BettingPortfolio, BettingTip } from './types';

// Helper to sort horses
const sortByProb = (horses: Horse[]) => [...horses].sort((a, b) => b.estimatedProb - a.estimatedProb);
const sortByEv = (horses: Horse[]) => [...horses].sort((a, b) => b.ev - a.ev);
const sortByUpset = (horses: Horse[]) => [...horses].sort((a, b) => (b.upsetIndex || 0) - (a.upsetIndex || 0));

function generatePortfolios(race: Race): BettingPortfolio[] {
    const horses = race.horses;
    if (horses.length === 0) return [];

    const sortedByProb = sortByProb(horses);
    const sortedByEv = sortByEv(horses);
    const sortedByUpset = sortByUpset(horses);

    const portfolios: BettingPortfolio[] = [];

    // 1. 堅実 (Solid/Conservative)
    // Strategy: Bet on high probability outcomes.
    // Target: Win/Place for top favorite, Wide for top 2 favorites.
    const solidTips: BettingTip[] = [];
    const favorite = sortedByProb[0];
    const secondFav = sortedByProb[1];

    if (favorite.estimatedProb > 0.3) {
        solidTips.push({
            type: '複勝',
            selection: [favorite.number],
            confidence: 0.9,
            reason: `的中率重視。AI推定勝率${(favorite.estimatedProb * 100).toFixed(1)}%の本命軸。`,
            alloc: 50
        });
    }

    if (favorite && secondFav) {
        solidTips.push({
            type: 'ワイド',
            selection: [favorite.number, secondFav.number],
            confidence: 0.8,
            reason: '上位2頭の安定した決着を想定。',
            alloc: 50
        });
    }

    portfolios.push({
        id: 'conservative',
        name: '🛡️ 堅実 (Conservative)',
        description: '着実に資金を守りつつ増やす (予算配分: 50%-50%)',
        tips: solidTips,
        riskLevel: 'Low'
    });

    // 2. バランス (Balanced)
    // Strategy: EV maximization.
    // Target: Horses with EV > 0, focusing on Win/Uma-ren.
    const balancedTips: BettingTip[] = [];
    const highEvHorses = sortedByEv.filter(h => h.ev > 0).slice(0, 3);

    if (highEvHorses.length > 0) {
        const bestEv = highEvHorses[0];
        balancedTips.push({
            type: '単勝',
            selection: [bestEv.number],
            confidence: 0.7,
            reason: `期待値No.1 (EV: ${bestEv.ev.toFixed(2)})。妙味あり。`,
            alloc: 40
        });

        // Box or Formation for top EV horses
        if (highEvHorses.length >= 2) {
            const evSecond = highEvHorses[1];
            balancedTips.push({
                type: '馬連',
                selection: [bestEv.number, evSecond.number],
                confidence: 0.6,
                reason: '期待値の高い2頭の連対狙い。',
                alloc: 30
            });

            // Hedge/Wide
            balancedTips.push({
                type: 'ワイド',
                selection: [bestEv.number, evSecond.number],
                confidence: 0.7,
                reason: '保険のワイド。',
                alloc: 30
            });
        }
    } else {
        // Fallback if no positive EV (should be rare with normalized probs, but possible)
        balancedTips.push({
            type: '単勝',
            selection: [favorite.number],
            confidence: 0.6,
            reason: '特出した期待値馬が不在のため、本命の押し切りを信頼。',
            alloc: 100
        });
    }

    portfolios.push({
        id: 'balanced',
        name: '⚖️ バランス (Balanced)',
        description: '期待値の高い馬で回収率100%超を狙う',
        tips: balancedTips,
        riskLevel: 'Medium'
    });

    // 3. 夢枠 (Dream)
    // Strategy: Upset index. Low budget allocation.
    // Target: Wide/Sanrenpuku involving long shots.
    // "Risk Hedge": Include a ticket that wins even if the favorite loses.
    const dreamTips: BettingTip[] = [];
    const upsetCandidates = sortedByUpset.filter(h => (h.upsetIndex || 0) > 0).slice(0, 2);

    if (upsetCandidates.length > 0) {
        const topUpset = upsetCandidates[0];
        // 穴流し
        dreamTips.push({
            type: 'ワイド',
            selection: [topUpset.number, favorite.number], // Flow from Upset to Fav
            confidence: 0.3,
            reason: `穴馬${topUpset.name}からの紐荒れ狙い。`,
            alloc: 50 // of the 3% budget
        });

        // "Survival Ticket" - Box of non-favorites (if Upset + 2nd Fav + 3rd Fav)
        if (sortedByProb.length > 4) {
            dreamTips.push({
                type: '三連複',
                selection: [topUpset.number, sortedByProb[1].number, sortedByProb[2].number], // Upset + 2nd + 3rd (Fav omitted)
                confidence: 0.1,
                reason: '【軸飛び生存券】1番人気が飛んだ場合の高配当狙い。',
                alloc: 50
            });
        }
    } else {
        dreamTips.push({
            type: '三連単',
            selection: [favorite.number, secondFav.number, sortedByProb[2]?.number || 0],
            confidence: 0.2,
            reason: '穴馬不在。順当決着の完全的中に賭ける。',
            alloc: 100
        });
    }

    portfolios.push({
        id: 'dream',
        name: '🦄 夢枠 (Dream - 予算3%)',
        description: '一発逆転、事故待ち。現実的ではないが夢を見る。',
        tips: dreamTips,
        riskLevel: 'High'
    });

    return portfolios;
}

export function analyzeRace(race: Race): Race {
    const horses = race.horses;

    // 1. Market Probability (Normalized)
    // Prob = (1 / Odds) / Sum(1/Odds)
    let sumInverseOdds = 0;
    const validHorses = horses.filter(h => h.odds > 0);

    validHorses.forEach(h => {
        sumInverseOdds += 1 / h.odds;
    });

    // Prevention for 0 sum
    if (sumInverseOdds === 0) sumInverseOdds = 1;

    // Fallback if no odds available
    const hasOdds = validHorses.length > 0;
    const equalProb = horses.length > 0 ? 1 / horses.length : 0;

    horses.forEach(h => {
        if (h.odds > 0) {
            h.marketProb = (1 / h.odds) / sumInverseOdds;
        } else {
            h.marketProb = hasOdds ? 0 : equalProb;
        }
    });

    // 2. Estimated Model (Advanced)
    let sumScore = 0;
    const defaultBaseScore = 10; // Fallback when odds are missing

    horses.forEach(h => {
        // Base: Inverse Odds (The market is the best baseline)
        let baseScore = h.odds > 0 ? (100 / h.odds) : defaultBaseScore;

        // Factors
        const factors: string[] = [];
        let multiplier = 1.0;

        // Factor 1: Gate position (Inner is generally better)
        if (h.gate <= 2) {
            multiplier += 0.05; // +5%
            factors.push('好枠(内)');
        } else if (h.gate >= 7 && horses.length > 10) {
            multiplier -= 0.03;
            factors.push('外枠');
        }

        // Factor 2: Weight Change
        if (h.weightChange !== undefined) {
            if (h.weightChange >= 10) {
                multiplier -= 0.1;
                factors.push(`馬体増+${h.weightChange}kg`);
            } else if (h.weightChange <= -10) {
                multiplier -= 0.1;
                factors.push(`馬体減${h.weightChange}kg`);
            } else if (Math.abs(h.weightChange) <= 2) {
                multiplier += 0.02;
                factors.push('馬体安定');
            }
        }

        // Factor 3: Jockey
        const topJockeys = ['森泰斗', '御神本', '笹川翼', '矢野', '本田正', '翼', '川田', 'ルメール', 'デムーロ', '福永'];
        if (topJockeys.some(j => h.jockey.includes(j))) {
            multiplier += 0.1;
            factors.push('有力騎手');
        }

        // Factor 4: Upset Index (穴馬指数)
        let upsetIndex = 0;
        if (h.odds >= 50) {
            upsetIndex = 0.8;
            factors.push('大穴候補 ★★★');
        } else if (h.odds >= 30) {
            upsetIndex = 0.5;
            factors.push('穴馬候補 ★★');
        } else if (h.odds >= 15) {
            upsetIndex = 0.3;
            factors.push('中穴 ★');
        } else if (h.odds > 0 && h.odds < 5.0) {
            factors.unshift(`本命(${h.odds.toFixed(1)}倍)`);
        }

        // Store upset index for UI display
        h.upsetIndex = upsetIndex;

        // Apply Multiplier
        let finalScore = baseScore * multiplier;

        h.estimatedProb = finalScore;
        h.factors = factors.slice(0, 3);
        sumScore += finalScore;
    });

    // Normalize Estimated Prob
    horses.forEach(h => {
        if (sumScore > 0) {
            h.estimatedProb = h.estimatedProb / sumScore;
        } else {
            h.estimatedProb = equalProb;
        }
    });

    // 3. EV Calculation
    // EV = (EstimatedProb * Odds) - 1
    horses.forEach(h => {
        if (h.odds > 0) {
            h.ev = (h.estimatedProb * h.odds) - 1;
        } else {
            h.ev = 0;
        }
    });

    // 4. Portfolio Generation
    race.portfolios = generatePortfolios(race);

    return race;
}
