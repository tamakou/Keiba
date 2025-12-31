import 'server-only';

import Link from 'next/link';
import { Race } from '@/lib/types';

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

// Group races by system
function groupBySystem(races: Race[]): { nar: Race[]; jra: Race[] } {
  const nar: Race[] = [];
  const jra: Race[] = [];
  for (const r of races) {
    if (r.system === 'JRA') {
      jra.push(r);
    } else {
      nar.push(r);
    }
  }
  return { nar, jra };
}

export default async function Home({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const params = await searchParams;
  // デフォルトは今日or 20260105（JRAテスト用）
  const dateStr = params.date || formatDate(new Date());
  const races = await getRacesServer(dateStr);
  const { nar, jra } = groupBySystem(races);

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
        <p>Real-time Probabilities & EV Analysis (NAR + JRA)</p>

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

      {/* JRA Section */}
      {jra.length > 0 && (
        <>
          <h2 style={{ marginTop: '30px', marginBottom: '15px', borderBottom: '2px solid #4caf50', paddingBottom: '8px' }}>
            🏇 JRA (中央競馬) - {jra.length}レース
          </h2>
          <div className="race-grid">
            {jra.map((race) => (
              <Link href={`/races/${race.id}?system=JRA`} key={race.id} className="race-card glass" style={{ borderLeft: '4px solid #4caf50' }}>
                <div className="race-time">{race.time}</div>
                <div className="race-name">{race.name}</div>
                <div className="race-meta">{race.course}</div>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* NAR Section */}
      {nar.length > 0 && (
        <>
          <h2 style={{ marginTop: '30px', marginBottom: '15px', borderBottom: '2px solid #ff9800', paddingBottom: '8px' }}>
            🐴 NAR (地方競馬) - {nar.length}レース
          </h2>
          <div className="race-grid">
            {nar.map((race) => (
              <Link href={`/races/${race.id}?system=NAR`} key={race.id} className="race-card glass" style={{ borderLeft: '4px solid #ff9800' }}>
                <div className="race-time">{race.time}</div>
                <div className="race-name">{race.name}</div>
                <div className="race-meta">{race.course}</div>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* No races */}
      {races.length === 0 && (
        <div className="glass" style={{ padding: '20px', textAlign: 'center', marginTop: '30px' }}>
          該当日のレースが見つかりません。日付を変更してください。
          <br />(NAR + JRA 両方を検索済み)
        </div>
      )}
    </main>
  );
}
