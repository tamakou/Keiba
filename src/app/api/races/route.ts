import { NextResponse } from 'next/server';
import { getRaceList } from '@/lib/netkeiba';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    // Default to today (20251231) or use parameter
    // User metadata says 2025-12-31 is today.
    const date = searchParams.get('date') || '20251231';

    try {
        const races = await getRaceList(date);
        return NextResponse.json({ races });
    } catch (error) {
        console.error(error);
        return NextResponse.json({ error: 'Failed to fetch races' }, { status: 500 });
    }
}
