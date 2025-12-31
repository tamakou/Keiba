import 'server-only'; // wait, client component cannot import server-only.
// I switched to 'use client' because I need useEffect/fetch for API?
// Or I can use Server Components for the list? 
// Next 13 App Router: Page is server component by default.
// I can make it async and fetch directly!
// But then I can't use 'use client' logic unless I separate components.
// For simplicity, I'll keep the page as Server Component and fetch data there.

import Link from 'next/link';
// import { Race } from '@/lib/types';

// Helper to fetch data on server
async function getRacesServer(date: string) {
  const { getRaceList } = await import('@/lib/netkeiba');
  return await getRaceList(date);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseDate(s: string): Date {
  const y = parseInt(s.substring(0, 4));
  const m = parseInt(s.substring(4, 6)) - 1;
  const d = parseInt(s.substring(6, 8));
  return new Date(y, m, d);
}

export default async function Home({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const params = await searchParams;
  const dateStr = params.date || '20251231';
  const races = await getRacesServer(dateStr);

  // Calculate Prev/Next
  const currentDate = parseDate(dateStr);
  const prevDate = new Date(currentDate);
  prevDate.setDate(currentDate.getDate() - 1);
  const prevStr = formatDate(prevDate);
  const nextDate = new Date(currentDate);
  nextDate.setDate(currentDate.getDate() + 1);
  const nextStr = formatDate(nextDate);

  return (
    <main className="container">
      <div className="header">
        <h1>競馬シミュレーション</h1>
        <p>Real-time Probabilities & EV Analysis</p>

        <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginTop: '20px', alignItems: 'center' }}>
          <Link href={`/?date=${prevStr}`} style={{ color: 'var(--secondary)', textDecoration: 'none', fontSize: '1.1rem' }}>
            &larr; Prev ({prevStr})
          </Link>
          <span style={{ fontWeight: 'bold', fontSize: '1.2rem' }}>
            {dateStr.substring(0, 4)}/{dateStr.substring(4, 6)}/{dateStr.substring(6, 8)}
          </span>
          <Link href={`/?date=${nextStr}`} style={{ color: 'var(--secondary)', textDecoration: 'none', fontSize: '1.1rem' }}>
            Next ({nextStr}) &rarr;
          </Link>
        </div>
      </div>

      <div className="race-grid">
        {races.map((race) => (
          <Link href={`/races/${race.id}`} key={race.id} className="race-card glass">
            <div className="race-time">{race.time}</div>
            <div className="race-name">{race.name}</div>
            <div className="race-meta">{race.course}</div>
          </Link>
        ))}
        {races.length === 0 && (
          <div className="glass" style={{ padding: '20px', textAlign: 'center', gridColumn: '1/-1' }}>
            No races found for today (2025-12-31). Please check the date or source.
            <br />(Target: Ohi/TCK via NAR)
          </div>
        )}
      </div>
    </main>
  );
}
