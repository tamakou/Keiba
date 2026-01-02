// src/lib/types.ts

export type BetType = '単勝' | '複勝' | 'ワイド' | '馬連' | '馬単' | '三連複' | '三連単';

export type RaceSystem = 'NAR' | 'JRA';

export interface DataSource {
    url: string;
    fetchedAtJst: string; // 例: "2025/12/31 10:25:12"
    items: string[];      // 例: ["race_meta", "entries", "odds:単勝"]
    note?: string;
}

export interface OddsEntry {
    raw: string;          // セルの生文字列
    value: number | null; // 単一オッズ（単勝/ワイド等）
    min: number | null;   // 複勝レンジ等
    max: number | null;
}

export interface OddsTable {
    type: BetType;
    url: string;
    fetchedAtJst: string;
    odds: Record<string, OddsEntry>; // key: 単勝/複勝は "馬番"、ワイド/馬連は "1-2"、三連複は "1-2-3"、三連単は "1>2>3"
    note?: string;
}

export type OddsTables = Partial<Record<BetType, OddsTable>>;

export interface HorseRun {
    date: string | null;
    venue: string | null;
    raceName: string | null;
    class: string | null;
    surfaceDistance: string | null; // 例: "ダ1600"
    finish: string | null;          // 例: "1"
    time: string | null;            // 走破タイム
    last3f: string | null;          // 上がり
    baba: string | null;            // 馬場状態: "良/稍/重/不"
    passing: string | null;         // 通過順: "2-2-1-1"
}

export interface Horse {
    gate: number;
    number: number;
    name: string;

    jockey: string;
    trainer: string;

    // 外部統計取得用（db.netkeibaへ正規化して使う）
    jockeyUrl?: string | null;
    trainerUrl?: string | null;

    // リアルタイム拡張
    weatherDetail?: {
        weather: string;   // "晴"
        wind: string;      // "北西 2m" (取得できれば)
        temperature: string; // "12.5" (取得できれば)
    };
    oddsHistory?: {
        fetchedAt: string;
        odds: Record<string, number>; // 単勝オッズ履歴 { "1": 2.5, "2": 3.0 }
    }[]; // 直近N回分
    oddsChangeAlert?: string[]; // "1番: 2.5->1.8 急落!" 等
}

export interface Horse {
    gate: number;
    number: number;
    name: string;

    jockey: string;
    trainer: string;

    // 外部統計取得用（db.netkeibaへ正規化して使う）
    jockeyUrl?: string | null;
    trainerUrl?: string | null;

    weight: string;              // "480(+2)" / 取れなければ "取得不可"
    weightValue: number | null;  // 480
    weightChange: number | null; // +2 / 欠損は null

    // 直前情報
    condition: '出走' | '取消' | '除外' | '競走除外';

    odds: number | null;         // 単勝（欠損 null）
    previousOdds: number | null; // 前回取得時のオッズ（比較用）
    popularity: number | null;

    horseUrl: string | null;     // 直近5走取得用
    last5: HorseRun[] | null;    // 欠損 null

    marketProb: number | null;   // 市場勝率（全頭揃わなければ null）
    estimatedProb: number;       // あなた推定（必ず正規化）
    ev: number | null;           // 単勝EV（oddsが無ければ null）
    fairOdds: number | null;     // フェアオッズ = 1/estimatedProb

    factors: string[];
    upsetIndex?: number;

    // Monte Carlo結果（互換用）
    modelTop2Prob?: number | null;
    modelTop3Prob?: number | null;
    marketTop2Prob?: number | null;
    marketTop3Prob?: number | null;
}

export interface BettingTip {
    type: BetType;
    selection: number[];
    confidence: number;
    reason: string;
    alloc?: number; // 既存互換（%）
    stakeYen?: number;
    odds?: number | null;
    prob?: number | null;
    ev?: number | null;
}

export interface BettingPortfolio {
    id: string;
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

export interface Race {
    id: string;
    name: string;
    date?: string;

    time: string;   // 取れなければ "取得不可"
    course: string; // 取れなければ "取得不可"
    weather: string;
    baba: string;
    venue: string;   // 競馬場名: 中山/東京/京都/阪神/大井 等

    horses: Horse[];

    // 取得証跡
    sources: DataSource[];

    // 券種別オッズ
    oddsTables?: OddsTables;

    // NAR/JRA区分
    system?: RaceSystem;

    // 既存互換
    sourceUrl?: string;
    scrapedAt?: string; // ISO推奨

    // リアルタイム拡張
    weatherDetail?: {
        weather: string;   // "晴"
        wind: string;      // "北西 2m" (取得できれば)
        temperature: string; // "12.5" (取得できれば)
    };
    oddsHistory?: {
        fetchedAt: string;
        odds: Record<string, number>; // 単勝オッズ履歴 { "1": 2.5, "2": 3.0 }
    }[]; // 直近N回分
    oddsChangeAlert?: string[]; // "1番: 2.5->1.8 急落!" 等

    // 分析結果
    analysis?: RaceAnalysis;
    portfolios?: BettingPortfolio[];
}
