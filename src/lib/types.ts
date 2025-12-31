export interface Race {
    id: string;
    name: string;
    date?: string;
    time: string;
    course: string;
    weather: string;
    baba: string; // Track condition
    horses: Horse[];
    sourceUrl?: string;
    scrapedAt?: string;
}

export interface Horse {
    gate: number; // Waku
    number: number; // Umaban
    name: string;
    jockey: string;
    trainer: string;
    weight: string; // e.g. "450(+2)"
    weightChange?: number; // Parsed change
    odds: number; // Win odds
    popularity: number; // Ninken
    upsetIndex?: number; // Upset potential index

    // Scraped Data for Model
    last5: string[]; // Ranks e.g. ["1", "3", "5", "outside", "1"]

    // Computed
    marketProb: number; // Normalized from odds
    estimatedProb: number; // Our model
    ev: number;

    // Reasoning
    factors: string[];
}

export interface BettingTip {
    type: '単勝' | '複勝' | 'ワイド' | '馬連' | '馬単' | '三連複' | '三連単';
    selection: number[]; // Horse numbers
    confidence: number; // 0-1
    reason: string;
    alloc?: number; // % allocation
}

export interface BettingPortfolio {
    id: string;
    name: string;
    description: string;
    tips: BettingTip[];
    riskLevel: 'Low' | 'Medium' | 'High';
}

export interface Race { // Updated Race to include analysis
    id: string;
    name: string;
    date?: string;
    time: string;
    course: string;
    weather: string;
    baba: string;
    horses: Horse[];
    sourceUrl?: string;
    scrapedAt?: string;

    // Analysis Results
    portfolios?: BettingPortfolio[];
}
