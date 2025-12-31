import { getRaceDetails } from '@/lib/netkeiba';
import { analyzeRace } from '@/lib/analysis';
import RaceDetailView from '@/components/RaceDetailView';

// Server Component
// Server Component
export default async function RacePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    let race = await getRaceDetails(id);

    if (!race) {
        return <div className="container">Race not found.</div>;
    }

    // Apply Analysis Logic
    race = analyzeRace(race);

    return <RaceDetailView race={race} />;
}
