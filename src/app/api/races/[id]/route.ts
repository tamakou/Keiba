import { NextResponse } from 'next/server';
import { getRaceDetails } from '@/lib/netkeiba';
import { analyzeRace } from '@/lib/analysis';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    // Await params if Next.js 15+ 
    const { id } = await params;

    try {
        const race = await getRaceDetails(id);

        if (!race) {
            return NextResponse.json({ error: 'Race not found' }, { status: 404 });
        }

        // --- Calculation Logic (Shared) ---
        // Apply probability and EV analysis
        analyzeRace(race);

        return NextResponse.json({ race });
    } catch (error) {
        console.error(error);
        return NextResponse.json({ error: 'Failed to fetch details' }, { status: 500 });
    }
}
