// src/app/races/[id]/page.tsx
import { getRaceDetails } from '@/lib/netkeiba';
import { analyzeRace } from '@/lib/analysis';
import RaceDetailView from '@/components/RaceDetailView';
import { RaceSystem } from '@/lib/types';

// Server Component with searchParams support
export default async function RacePage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { id } = await params;
    const sp = (await searchParams) ?? {};

    // system パラメータ（NAR/JRA）
    const systemRaw = Array.isArray(sp.system) ? sp.system[0] : sp.system;
    const system: RaceSystem = systemRaw === 'JRA' ? 'JRA' : 'NAR';

    // 予算パラメータ取得
    const budgetYen = Number(Array.isArray(sp.budgetYen) ? sp.budgetYen[0] : sp.budgetYen);
    const maxBets = Number(Array.isArray(sp.maxBets) ? sp.maxBets[0] : sp.maxBets);
    const dreamPct = Number(Array.isArray(sp.dreamPct) ? sp.dreamPct[0] : sp.dreamPct);

    let race = await getRaceDetails(id, system);

    if (!race) {
        return <div className="container">Race not found.</div>;
    }

    // 分析実行（予算オプション付き）
    race = analyzeRace(race, {
        budgetYen: Number.isFinite(budgetYen) ? budgetYen : undefined,
        maxBets: Number.isFinite(maxBets) ? maxBets : undefined,
        dreamPct: Number.isFinite(dreamPct) ? dreamPct : undefined,
        enableOptimization: true,
    });

    return <RaceDetailView race={race} />;
}

