import 'server-only';

import Link from 'next/link';
import { Race } from '@/lib/types';

// Helper to fetch data on server
async function getRacesServer(date: string) {
  try {
    const { getRaceList } = await import('@/lib/netkeiba');
    return await getRaceList(date);
  } catch (e) {
    console.error('Failed to fetch race list:', e);
    return [];
  }
}

function normalizeDateParam(raw?: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 8) return null;
  const y = parseInt(digits.substring(0, 4), 10);
  const m = parseInt(digits.substring(4, 6), 10);
  const d = parseInt(digits.substring(6, 8), 10);
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return digits;
}

function formatDateUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseDateUTC(s: string): Date {
  const y = parseInt(s.substring(0, 4), 10);
  const m = parseInt(s.substring(4, 6), 10) - 1;
  const d = parseInt(s.substring(6, 8), 10);
  return new Date(Date.UTC(y, m, d));
}

function todayJstYYYYMMDD(): string {
  // サーバのタイムゾーンに依存せずJSTの今日を作る
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year')?.value ?? '1970';
  const m = parts.find(p => p.type === 'month')?.value ?? '01';
  const d = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${y}${m}${d}`;
}

async function findNearestDateWithRaces(baseYYYYMMDD: string, maxDays = 7): Promise<{ date: string; races: Race[] } | null> {
  const base = parseDateUTC(baseYYYYMMDD);
  // 近い未来を優先、次に過去
  for (let offset = 1; offset <= maxDays; offset++) {
    for (const sign of [1, -1]) {
      const dt = new Date(base);
      dt.setUTCDate(dt.getUTCDate() + sign * offset);
      const ds = formatDateUTC(dt);
      const rs = await getRacesServer(ds);
      if (rs.length > 0) return { date: ds, races: rs };
    }
  }
  return null;
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
  const requested = normalizeDateParam(params.date);
  const defaultDate = todayJstYYYYMMDD();
  const requestedOrDefault = requested ?? defaultDate;

  let dateStr = requestedOrDefault;
  let races = await getRacesServer(dateStr);
  let autoNote: string | null = null;

  if (races.length === 0) {
    // ユーザー指定日または今日にレースがない場合、近くの日を探す
    const found = await findNearestDateWithRaces(dateStr, 7);
    if (found) {
      autoNote = `指定日(${dateStr})にレースが無かったため、近い日(${found.date})を表示しています。`;
      dateStr = found.date;
      races = found.races;
    }
  }

  const { nar, jra } = groupBySystem(races);

  // Calculate Prev/Next
  const currentDate = parseDateUTC(dateStr);
  const prevDate = new Date(currentDate);
  prevDate.setUTCDate(currentDate.getUTCDate() - 1);
  const prevStr = formatDateUTC(prevDate);
  const nextDate = new Date(currentDate);
  nextDate.setUTCDate(currentDate.getUTCDate() + 1);
  const nextStr = formatDateUTC(nextDate);

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

        {autoNote && (
          <div className="glass" style={{ padding: '12px 16px', marginTop: '12px', textAlign: 'center' }}>
            {autoNote}
          </div>
        )}
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
