// src/lib/analysis.ts
import { Race, Horse, BettingPortfolio, BettingTip } from './types';
import { estimateFinishProbs } from './simulator';

const DEFAULT_BUDGET_YEN = 20000;
const MAX_TIPS = 7;
const DREAM_BUDGET_RATIO = 0.03;

function normalize(arr: number[]): number[] {
    const sum = arr.reduce((a, b) => a + b, 0);
    if (sum <= 0) return arr.map(() => 1 / arr.length);
    return arr.map(v => v / sum);
}

function topKForPlace(n: number): number {
    if (n <= 4) return 1;
    if (n <= 7) return 2;
    return 3;
}

function build3Factors(h: Horse, race: Race): string[] {
    const f: string[] = [];

    // 1) 枠
    if (h.gate > 0) {
        if (h.gate <= 2) f.push('好枠(内)');
        else if (h.gate >= 7 && race.horses.length > 10) f.push('外枠');
        else f.push('標準枠');
    } else {
        f.push('枠:取得不可');
    }

    // 2) 馬体重増減
    if (h.weightChange === null) f.push('馬体増減:取得不可');
    else if (Math.abs(h.weightChange) <= 2) f.push('馬体安定');
    else if (h.weightChange >= 10) f.push(`馬体増+${h.weightChange}kg`);
    else if (h.weightChange <= -10) f.push(`馬体減${h.weightChange}kg`);
    else f.push(`馬体変動${h.weightChange > 0 ? '+' : ''}${h.weightChange}kg`);

    // 3) 騎手
    const topJockeys = ['御神本', '笹川翼', '矢野', '本田正', 'ルメール', '川田', 'デムーロ', '福永', '森泰斗'];
    if (h.jockey === '取得不可') f.push('騎手:取得不可');
    else if (topJockeys.some(j => h.jockey.includes(j))) f.push('有力騎手');
    else f.push('騎手:標準');

    return f.slice(0, 3);
}

function calcModelWinProbs(race: Race): number[] {
    const baseScores = race.horses.map(h => (h.odds !== null && h.odds > 0 ? (1 / h.odds) : null));
    const canUseMarket = baseScores.every(v => v !== null);

    const scores = race.horses.map((h, i) => {
        let s = canUseMarket ? (baseScores[i] as number) : (1 / race.horses.length);

        if (h.gate > 0 && h.gate <= 2) s *= 1.05;
        if (h.gate >= 7 && race.horses.length > 10) s *= 0.97;

        if (h.weightChange !== null && Math.abs(h.weightChange) >= 10) s *= 0.90;

        const topJockeys = ['御神本', '笹川翼', '矢野', '本田正', 'ルメール', '川田', 'デムーロ', '福永', '森泰斗'];
        if (h.jockey !== '取得不可' && topJockeys.some(j => h.jockey.includes(j))) s *= 1.10;

        return Math.max(1e-9, s);
    });

    return normalize(scores);
}

function calcMarketWinProbs(race: Race): number[] | null {
    const inv = race.horses.map(h => (h.odds !== null && h.odds > 0 ? 1 / h.odds : null));
    if (!inv.every(v => v !== null)) return null;
    return normalize(inv as number[]);
}

function evCalc(p: number | null, odds: number | null): number | null {
    if (p === null || odds === null || odds <= 0) return null;
    return p * odds - 1;
}

function makePortfolios(race: Race): BettingPortfolio[] {
    const horses = [...race.horses];
    const byModelWin = [...horses].sort((a, b) => b.estimatedProb - a.estimatedProb);
    const n = horses.length;
    const kPlace = topKForPlace(n);

    const fav = byModelWin[0];
    const second = byModelWin[1];
    const third = byModelWin[2];

    // --- 堅実 ---
    const conservativeTips: BettingTip[] = [];

    conservativeTips.push({
        type: '複勝',
        selection: [fav.number],
        confidence: 0.85,
        reason: `的中率優先。本命の複勝で資金残し（複勝圏=Top${kPlace}）`,
        odds: null,
        prob: fav.modelTop3Prob,
        ev: null,
    });

    const pickWin = evCalc(fav.estimatedProb, fav.odds) !== null && (evCalc(fav.estimatedProb, fav.odds) as number) >= 0
        ? fav : second;

    if (pickWin) {
        conservativeTips.push({
            type: '単勝',
            selection: [pickWin.number],
            confidence: 0.55,
            reason: '堅実でも回収の芽を残す単勝',
            odds: pickWin.odds,
            prob: pickWin.estimatedProb,
            ev: evCalc(pickWin.estimatedProb, pickWin.odds),
        });
    }

    // 軸飛び生存券
    const survive = third || second;
    if (survive) {
        conservativeTips.push({
            type: '複勝',
            selection: [survive.number],
            confidence: 0.45,
            reason: '【軸飛び生存券】本命が沈んでも回収可能な複勝',
            odds: null,
            prob: survive.modelTop3Prob,
            ev: null,
        });
    }

    // --- バランス ---
    const balancedTips: BettingTip[] = [];
    const positiveEv = horses
        .map(h => ({ h, e: evCalc(h.estimatedProb, h.odds) }))
        .filter(x => x.e !== null && (x.e as number) > 0)
        .sort((a, b) => (b.e as number) - (a.e as number));

    if (positiveEv.length > 0) {
        const b1 = positiveEv[0].h;
        balancedTips.push({
            type: '単勝',
            selection: [b1.number],
            confidence: 0.65,
            reason: `EV優先：単勝EVが最大 (EV: ${((positiveEv[0].e || 0) * 100).toFixed(1)}%)`,
            odds: b1.odds,
            prob: b1.estimatedProb,
            ev: evCalc(b1.estimatedProb, b1.odds),
        });

        const b2 = positiveEv[1]?.h || second;
        if (b2) {
            balancedTips.push({
                type: '単勝',
                selection: [b2.number],
                confidence: 0.55,
                reason: 'リスク分散：EV/勝率上位をもう1点',
                odds: b2.odds,
                prob: b2.estimatedProb,
                ev: evCalc(b2.estimatedProb, b2.odds),
            });
        }

        if (second) {
            balancedTips.push({
                type: '複勝',
                selection: [second.number],
                confidence: 0.50,
                reason: '【軸飛び生存券】複勝で下振れ耐性確保',
                odds: null,
                prob: second.modelTop3Prob,
                ev: null,
            });
        }
    } else {
        balancedTips.push({
            type: '単勝',
            selection: [fav.number],
            confidence: 0.55,
            reason: 'EV算出不能のため勝率上位の単勝',
            odds: fav.odds,
            prob: fav.estimatedProb,
            ev: evCalc(fav.estimatedProb, fav.odds),
        });
        if (second) {
            balancedTips.push({
                type: '複勝',
                selection: [second.number],
                confidence: 0.55,
                reason: '一点依存回避のため複勝',
                odds: null,
                prob: second.modelTop3Prob,
                ev: null,
            });
        }
    }

    // --- 夢枠 ---
    const dreamTips: BettingTip[] = [];
    const longShot = [...horses]
        .filter(h => (h.odds ?? 0) >= 15)
        .sort((a, b) => ((b.odds ?? 0) - (a.odds ?? 0)))[0];

    if (longShot && longShot.odds) {
        dreamTips.push({
            type: '単勝',
            selection: [longShot.number],
            confidence: 0.20,
            reason: '夢枠：高オッズの単勝で一撃狙い（予算3%上限）',
            odds: longShot.odds,
            prob: longShot.estimatedProb,
            ev: evCalc(longShot.estimatedProb, longShot.odds),
        });
    } else if (third) {
        dreamTips.push({
            type: '単勝',
            selection: [third.number],
            confidence: 0.20,
            reason: '夢枠：穴馬の単勝',
            odds: third.odds,
            prob: third.estimatedProb,
            ev: evCalc(third.estimatedProb, third.odds),
        });
    }

    // ステーク配分
    function allocateYen(tips: BettingTip[], total: number): BettingTip[] {
        const nTips = Math.min(tips.length, MAX_TIPS);
        const use = tips.slice(0, nTips);
        const base = Math.floor(total / nTips / 100) * 100;
        let rem = total - base * nTips;

        for (const tip of use) {
            tip.stakeYen = base;
            tip.alloc = Math.round((base / total) * 100);
        }
        let i = 0;
        while (rem >= 100 && i < use.length) {
            use[i].stakeYen = (use[i].stakeYen ?? 0) + 100;
            rem -= 100;
            i++;
        }
        return use;
    }

    const dreamBudget = Math.floor(DEFAULT_BUDGET_YEN * DREAM_BUDGET_RATIO);

    return [
        {
            id: 'conservative',
            name: '🛡️ 堅実（的中優先）',
            description: '複勝中心で資金を残す',
            scenario: '順当〜やや波乱でも複勝で耐える',
            tips: allocateYen(conservativeTips, DEFAULT_BUDGET_YEN),
            riskLevel: 'Low',
        },
        {
            id: 'balanced',
            name: '⚖️ バランス（EV優先）',
            description: '単勝EVを取りに行きつつ、複勝で下振れを抑える',
            scenario: '本命〜中穴が勝ち切る想定',
            tips: allocateYen(balancedTips, DEFAULT_BUDGET_YEN),
            riskLevel: 'Medium',
        },
        {
            id: 'dream',
            name: '🦄 夢枠（予算3%）',
            description: '一発逆転（予算は3%まで）',
            scenario: '高オッズの単勝が刺さる',
            tips: allocateYen(dreamTips, dreamBudget),
            riskLevel: 'High',
        },
    ];
}

export function analyzeRace(race: Race): Race {
    const notes: string[] = [];

    // 1) 市場勝率
    const marketWin = calcMarketWinProbs(race);
    if (!marketWin) {
        notes.push('単勝オッズが全頭揃っていないため、市場確率は取得不可');
    } else {
        race.horses.forEach((h, i) => { h.marketProb = marketWin[i]; });
    }

    // 2) モデル勝率
    const modelWin = calcModelWinProbs(race);
    race.horses.forEach((h, i) => {
        h.estimatedProb = modelWin[i];
        h.factors = build3Factors(h, race);
        h.ev = evCalc(h.estimatedProb, h.odds);

        // 穴馬指数
        if (h.odds !== null) {
            if (h.odds >= 50) h.upsetIndex = 0.8;
            else if (h.odds >= 30) h.upsetIndex = 0.5;
            else if (h.odds >= 15) h.upsetIndex = 0.3;
            else h.upsetIndex = 0;
        }
    });

    // 3) Monte Carlo で Top2/Top3 推定
    const iterations = 20000;
    const rng = Math.random;

    // モデル
    const modelProbs = estimateFinishProbs(modelWin, iterations, rng);
    race.horses.forEach((h, i) => {
        h.modelTop2Prob = modelProbs.top2[i];
        h.modelTop3Prob = modelProbs.top3[i];
    });

    // 市場
    if (marketWin) {
        const marketProbs = estimateFinishProbs(marketWin, iterations, rng);
        race.horses.forEach((h, i) => {
            h.marketTop2Prob = marketProbs.top2[i];
            h.marketTop3Prob = marketProbs.top3[i];
        });
    }

    // 4) ポートフォリオ
    race.portfolios = makePortfolios(race);

    race.analysis = {
        iterations,
        notes,
        marketAvailable: !!marketWin,
        modelAvailable: true,
    };

    return race;
}
