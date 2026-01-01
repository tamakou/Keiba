// src/app/api/races/[id]/route.ts
import { NextResponse } from 'next/server';
import { getRaceDetails } from '@/lib/netkeiba';
import { analyzeRace } from '@/lib/analysis';
import { RaceSystem } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const { searchParams } = new URL(request.url);

    // system パラメータ（NAR/JRA）
    const systemRaw = searchParams.get('system');
    const system: RaceSystem = systemRaw === 'JRA' ? 'JRA' : 'NAR';

    // 可変予算パラメータ
    const budgetYen = Number(searchParams.get('budgetYen'));
    const maxBets = Number(searchParams.get('maxBets'));
    const dreamPct = Number(searchParams.get('dreamPct'));
    const minUnitYen = Number(searchParams.get('minUnitYen'));

    try {
        const race = await getRaceDetails(id, system);

        if (!race) {
            return NextResponse.json({ error: 'Race not found' }, { status: 404 });
        }

        // 分析実行（予算オプション付き）
        await analyzeRace(race, {
            budgetYen: Number.isFinite(budgetYen) ? budgetYen : undefined,
            maxBets: Number.isFinite(maxBets) ? maxBets : undefined,
            dreamPct: Number.isFinite(dreamPct) ? dreamPct : undefined,
            minUnitYen: Number.isFinite(minUnitYen) ? minUnitYen : undefined,
            enableOptimization: true,
        });

        return NextResponse.json({ race });
    } catch (error) {
        console.error(error);
        return NextResponse.json({ error: 'Failed to fetch details' }, { status: 500 });
    }
}
