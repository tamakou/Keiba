export type DataItem =
    | 'race_meta'
    | 'entries'
    | 'win_place_odds'
    | 'other_odds'
    | 'horse_history';

export interface DataSource {
    url: string;
    fetchedAtJst: string;
    items: DataItem[];
    note?: string;
}

export interface Race {
    id: string;
    name: string;

    // レース基本情報（取れない時は必ず "取得不可"）
    date?: string;
    time: string;
    course: string;
    weather: string;
    baba: string;

    horses: Horse[];

    // 取得元の証跡
    sources: DataSource[];

    // 互換用
    sourceUrl?: string;
    scrapedAt?: string;

    // 分析結果
    analysis?: RaceAnalysis;
    portfolios?: BettingPortfolio[];
}

export interface Horse {
    gate: number;
    number: number;
    name: string;

    jockey: string;
    trainer: string;

    weight: string;
    weightChange: number | null;

    // 単勝オッズ（取れない場合は null）
    odds: number | null;

    popularity: number | null;

    // 直近5走（取れないなら null）
    last5: string[] | null;

    // 市場確率（単勝から。全頭揃わなければ null）
    marketProb: number | null;

    // モデル勝率
    estimatedProb: number;

    // 期待値（単勝EV。オッズ取れない場合は null）
    ev: number | null;

    // 根拠3点
    factors: string[];

    // シミュレーション由来の Top2/Top3
    modelTop2Prob?: number | null;
    modelTop3Prob?: number | null;
    marketTop2Prob?: number | null;
    marketTop3Prob?: number | null;

    // 穴馬指数
    upsetIndex?: number;
}

export type BetType =
    | '単勝'
    | '複勝'
    | 'ワイド'
    | '馬連'
    | '三連複'
    | '三連単';

export interface BettingTip {
    type: BetType;
    selection: number[];
    confidence: number;
    reason: string;

    odds?: number | null;
    prob?: number | null;
    ev?: number | null;

    stakeYen?: number;
    alloc?: number;
}

export interface BettingPortfolio {
    id: 'conservative' | 'balanced' | 'dream';
    name: string;
    description: string;
    scenario?: string;
    tips: BettingTip[];
    riskLevel: 'Low' | 'Medium' | 'High';
}

export interface RaceAnalysis {
    iterations: number;
    notes: string[];
    marketAvailable: boolean;
    modelAvailable: boolean;
}
