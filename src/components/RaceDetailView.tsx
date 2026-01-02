'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Race, Horse } from '@/lib/types';
import RaceAnimation3D, { SimMode } from './RaceAnimation3D';
import { sampleOrderPlackettLuce } from '@/lib/simulator';

export default function RaceDetailView({ race: initialRace }: { race: Race }) {
    const [race, setRace] = useState<Race>(initialRace);
    useEffect(() => setRace(initialRace), [initialRace]);

    const [simOrder, setSimOrder] = useState<Horse[] | null>(null);
    const [isSimulating, setIsSimulating] = useState(false);
    const [simMode, setSimMode] = useState<SimMode>('visual');

    // Refresh Logic
    const sp = useSearchParams();
    const system = (race.system ?? 'NAR');
    const budgetYen = sp.get('budgetYen');
    const maxBets = sp.get('maxBets');
    const dreamPct = sp.get('dreamPct');
    const minUnitYen = sp.get('minUnitYen');

    const [isRefreshing, setIsRefreshing] = useState(false);
    const [autoRefresh, setAutoRefresh] = useState(true);

    const refresh = async () => {
        try {
            setIsRefreshing(true);
            const qs = new URLSearchParams();
            qs.set('system', system);
            if (budgetYen) qs.set('budgetYen', budgetYen);
            if (maxBets) qs.set('maxBets', maxBets);
            if (dreamPct) qs.set('dreamPct', dreamPct);
            if (minUnitYen) qs.set('minUnitYen', minUnitYen);

            const res = await fetch(`/api/races/${race.id}?` + qs.toString(), { cache: 'no-store' });
            if (!res.ok) return;
            const json = await res.json();
            if (json?.race) setRace(json.race);
        } finally {
            setIsRefreshing(false);
        }
    };

    useEffect(() => {
        if (!autoRefresh) return;
        const id = setInterval(() => { refresh(); }, 30_000);
        return () => clearInterval(id);
    }, [autoRefresh, race.id, system, budgetYen, maxBets, dreamPct, minUnitYen]);

    const startSimulation = () => {
        // weights（相対値でOK：正規化不要）
        const weights = race.horses.map(h => {
            let score = h.estimatedProb;

            const conditionFactor = 0.8 + Math.random() * 0.4;
            score *= conditionFactor;

            const odds = h.odds ?? 0;
            if (odds > 20) {
                score += Math.random() * Math.random() * 0.3;
            } else if (odds > 10) {
                score += Math.random() * Math.random() * 0.15;
            }

            score += (Math.random() - 0.5) * 0.1;
            return Math.max(0.001, score);
        });

        // ✅ Plackett–Luce で「着順（index配列）」をサンプル
        const orderIdx = sampleOrderPlackettLuce(weights, Math.random);

        // ✅ Horse配列（1着→最下位）
        const finishOrder = orderIdx.map(i => race.horses[i]);

        setSimOrder(finishOrder);
        setIsSimulating(true);
    };

    // Parse race date
    let isPast = false;
    let dataLabel = 'Real-time';
    let isStale = false;

    if (race.date) {
        const y = parseInt(race.date.substring(0, 4));
        const m = parseInt(race.date.substring(4, 6)) - 1;
        const d = parseInt(race.date.substring(6, 8));
        const raceDate = new Date(y, m, d);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (raceDate < today) {
            isPast = true;
            dataLabel = `Final Data (${race.date.substring(0, 4)}/${race.date.substring(4, 6)}/${race.date.substring(6, 8)})`;
        }
    }

    if (!isPast && race.scrapedAt) {
        const scraped = new Date(race.scrapedAt);
        const now = new Date();
        const diffMs = now.getTime() - scraped.getTime();
        if (diffMs > 10 * 60 * 1000) { // 10分以上
            isStale = true;
        }
    }

    const displayProb = (v: number | null | undefined) => v == null ? '取得不可' : `${(v * 100).toFixed(1)}%`;
    const displayOdds = (v: number | null | undefined) => v == null ? '取得不可' : v.toFixed(1);
    const displayEv = (v: number | null | undefined) => v == null ? '取得不可' : `${(v * 100).toFixed(1)}%`;

    return (
        <div className="container" style={{ maxWidth: '1200px' }}>
            <div className="header" style={{ textAlign: 'left', marginBottom: '20px' }}>
                <Link href="/" style={{ color: '#888', textDecoration: 'none' }}>&larr; Back to List</Link>
                <h1 style={{ margin: '10px 0' }}>{race.name}</h1>
                <p className="race-meta">
                    {race.time} | {race.course} | Weather: {race.weather} | Baba: {race.baba}
                </p>
                <p style={{ fontSize: '0.9rem', color: isPast ? '#ffcc00' : isStale ? '#ff4444' : '#666', marginTop: '5px' }}>
                    Status: {dataLabel} {isPast ? '(Final Odds)' : ''}
                    {isStale && <span style={{ fontWeight: 'bold', marginLeft: 10 }}>⚠️ Data is STALE ({Math.floor((new Date().getTime() - new Date(race.scrapedAt!).getTime()) / 60000)}m ago)</span>}
                </p>

                {/* Odds Change Alert */}
                {race.oddsChangeAlert && race.oddsChangeAlert.length > 0 && (
                    <div style={{ background: '#300', color: '#ff8888', padding: '10px', borderRadius: '4px', marginTop: '10px', border: '1px solid #f00' }}>
                        <div style={{ fontWeight: 'bold' }}>⚠️ Odds Changed Significantly!</div>
                        {race.oddsChangeAlert.map((msg, i) => <div key={i}>{msg}</div>)}
                    </div>
                )}

                <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 10 }}>
                    <button
                        onClick={refresh}
                        disabled={isRefreshing}
                        style={{ padding: '6px 10px', borderRadius: 6, background: '#333', color: '#fff', border: '1px solid #555', cursor: 'pointer' }}
                    >
                        {isRefreshing ? 'Updating…' : '🔄 Update (Odds/AI/Portfolio)'}
                    </button>

                    <label style={{ fontSize: '0.85rem', color: '#aaa', display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
                        Auto refresh (30s)
                    </label>
                </div>

                <div style={{
                    fontSize: '0.8rem',
                    color: '#888',
                    marginTop: '10px',
                    borderTop: '1px solid #333',
                    paddingTop: '5px',
                    display: 'flex',
                    gap: '15px',
                    flexWrap: 'wrap'
                }}>
                    <span>
                        📊 Acquired at: <span style={{ color: '#fff' }}>
                            {race.scrapedAt
                                ? new Date(race.scrapedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST'
                                : '取得不可'}
                        </span>
                    </span>
                    <span>
                        Source: {race.sourceUrl ? <Link href={race.sourceUrl} target="_blank" style={{ color: '#4da6ff' }}>NetKeiba</Link> : '取得不可'}
                    </span>
                    {race.analysis && (
                        <span>
                            Monte Carlo: {race.analysis.iterations.toLocaleString()} iterations
                        </span>
                    )}
                </div>
            </div>

            {/* Analysis Notes */}
            {race.analysis?.notes && race.analysis.notes.length > 0 && (
                <div className="glass" style={{ padding: '12px 16px', marginBottom: '20px', borderLeft: '4px solid #ff9800' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: 6 }}>⚠️ データ取得/推定の注意</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {race.analysis.notes.map((n, i) => <li key={i} style={{ color: '#ccc' }}>{n}</li>)}
                    </ul>
                </div>
            )}

            {/* Data Sources */}
            {race.sources?.length > 0 && (
                <div className="glass" style={{ padding: 12, marginBottom: 20 }}>
                    <div style={{ fontWeight: 'bold', marginBottom: 6 }}>🔎 Data Sources ({race.sources.length})</div>
                    <ul style={{ margin: 0, paddingLeft: 18, maxHeight: '150px', overflowY: 'auto' }}>
                        {race.sources.map((s, i) => (
                            <li key={i} style={{ marginBottom: 4, fontSize: '0.8rem' }}>
                                <Link href={s.url} target="_blank" style={{ color: '#4da6ff' }}>
                                    {s.items.join(', ')}
                                </Link>
                                <span style={{ color: '#aaa' }}> — {s.fetchedAtJst}</span>
                                {s.note && <span style={{ color: '#ffcc00' }}> ({s.note})</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="glass" style={{ padding: '20px', overflowX: 'auto' }}>
                <table className="detail-table">
                    <thead>
                        <tr>
                            <th>Card</th>
                            <th>Horse</th>
                            <th>Jockey/Trainer</th>
                            <th>Odds (Mkt%)</th>
                            <th>My Win%</th>
                            <th>My Top2%</th>
                            <th>My Top3%</th>
                            <th>EV(Win)</th>
                            <th style={{ width: '25%' }}>Factors</th>
                        </tr>
                    </thead>
                    <tbody>
                        {race.horses.map((h, i) => (
                            <tr key={`${h.number}-${i}`} style={{ backgroundColor: h.condition && h.condition !== '出走' ? 'rgba(255,0,0,0.1)' : undefined }}>
                                <td style={{ color: h.gate <= 2 ? '#fff' : '#888', fontWeight: 'bold' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span>{h.gate}-{h.number}</span>
                                        {h.condition && h.condition !== '出走' && <span style={{ fontSize: '0.7rem', color: '#ff4444' }}>{h.condition}</span>}
                                    </div>
                                </td>
                                <td>
                                    <div style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{h.name}</div>
                                    <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
                                        {h.weight}
                                        {h.weightChange != null && (
                                            <span style={{
                                                marginLeft: '5px',
                                                color: Math.abs(h.weightChange) >= 10 ? '#ff4444' : '#aaa'
                                            }}>
                                                ({h.weightChange > 0 ? '+' : ''}{h.weightChange})
                                            </span>
                                        )}
                                    </div>
                                    {h.last5 && h.last5.length > 0 && (
                                        <div style={{ fontSize: '0.7rem', color: '#888', marginTop: '2px' }}>
                                            直近: {h.last5.slice(0, 3).map(r => r.finish ?? '-').join(' → ')}
                                        </div>
                                    )}
                                </td>
                                <td>
                                    <div>{h.jockey}</div>
                                    <div style={{ fontSize: '0.8rem', color: '#888' }}>{h.trainer}</div>
                                </td>
                                <td>
                                    <div style={{ fontWeight: 'bold', color: '#fff' }}>
                                        {displayOdds(h.odds)}
                                    </div>
                                    <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
                                        ({displayProb(h.marketProb)})
                                    </div>
                                </td>
                                <td style={{ color: 'var(--primary)', fontWeight: 'bold' }}>
                                    {displayProb(h.estimatedProb)}
                                </td>
                                <td style={{ color: '#ddd' }}>
                                    {displayProb(h.modelTop2Prob)}
                                </td>
                                <td style={{ color: '#ddd' }}>
                                    {displayProb(h.modelTop3Prob)}
                                </td>
                                <td style={{
                                    color: (h.ev ?? -999) > 0 ? '#4caf50' : (h.ev ?? -999) > -0.1 ? '#fff' : '#ff4444',
                                    fontWeight: (h.ev ?? -999) > 0 ? 'bold' : 'normal'
                                }}>
                                    {displayEv(h.ev)}
                                </td>
                                <td>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                        {h.factors.map((f, fi) => (
                                            <span key={fi} className="badge">{f}</span>
                                        ))}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <div style={{ marginTop: '20px', fontSize: '0.8rem', color: '#666', textAlign: 'right' }}>
                    * EV = (Estimated Prob × Odds) - 1. Positive EV suggests value bet.
                </div>
            </div>

            {/* Simulation Controls */}
            <div style={{ marginTop: '40px', textAlign: 'center' }}>
                <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'center', gap: 20 }}>
                    <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                        <input type="radio" name="simMode" checked={simMode === 'visual'} onChange={() => setSimMode('visual')} style={{ marginRight: 6 }} />
                        Visual Replay
                    </label>
                    <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                        <input type="radio" name="simMode" checked={simMode === 'physics'} onChange={() => setSimMode('physics')} style={{ marginRight: 6 }} />
                        Physics Simulation
                    </label>
                </div>
                <button className="sim-button" onClick={startSimulation} disabled={isSimulating}>
                    {isSimulating ? 'Running...' : '▶ Start 3D Simulation'}
                </button>
            </div>


            {/* Betting Strategies */}
            {race.portfolios && (
                <div style={{ marginTop: '40px' }}>
                    <h2 style={{ marginBottom: '20px', borderBottom: '1px solid #444', paddingBottom: '10px' }}>
                        🎯 AI Betting Portfolios
                    </h2>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
                        {race.portfolios.map(pf => (
                            <div key={pf.id} className="glass" style={{ padding: '20px', borderLeft: `4px solid ${GetRiskColor(pf.riskLevel)}` }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                                    <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{pf.name}</h3>
                                    <span style={{
                                        backgroundColor: GetRiskColor(pf.riskLevel),
                                        color: '#000',
                                        padding: '2px 8px',
                                        borderRadius: '4px',
                                        fontSize: '0.7rem',
                                        fontWeight: 'bold'
                                    }}>
                                        {pf.riskLevel} Risk
                                    </span>
                                </div>
                                <p style={{ fontSize: '0.85rem', color: '#ccc', marginBottom: '5px' }}>
                                    {pf.description}
                                </p>
                                {pf.scenario && (
                                    <p style={{ fontSize: '0.8rem', color: '#888', marginBottom: '15px', fontStyle: 'italic' }}>
                                        想定シナリオ: {pf.scenario}
                                    </p>
                                )}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                    {pf.tips.map((tip, i) => (
                                        <div key={i} style={{ backgroundColor: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '4px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                                                <span style={{ fontWeight: 'bold', color: '#ffcc00' }}>
                                                    【{tip.type}】 {tip.selection.join('-')}
                                                </span>
                                                {tip.alloc && (
                                                    <span style={{ fontSize: '0.8rem', color: '#888' }}>
                                                        Alloc: {tip.alloc}%
                                                    </span>
                                                )}
                                            </div>
                                            <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
                                                {tip.reason}
                                            </div>
                                            <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '6px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                                                <span>
                                                    Prob: {tip.prob != null ? `${(tip.prob * 100).toFixed(1)}%` : '取得不可'}
                                                </span>
                                                <span>
                                                    Odds: {tip.odds != null ? tip.odds.toFixed(2) : '取得不可'}
                                                </span>
                                                <span style={{ color: (tip.ev ?? -1) > 0 ? '#4caf50' : (tip.ev ?? -1) > -0.1 ? '#fff' : '#ff4444', fontWeight: (tip.ev ?? -1) > 0 ? 'bold' : 'normal' }}>
                                                    EV: {tip.ev != null ? `${(tip.ev * 100).toFixed(1)}%` : '取得不可'}
                                                </span>
                                                {tip.stakeYen != null && (
                                                    <span style={{ color: '#ffcc00', fontWeight: 'bold' }}>
                                                        Stake: {tip.stakeYen.toLocaleString()}円
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div style={{ marginTop: '40px' }}>
                <Link href="/" style={{
                    display: 'inline-block',
                    padding: '10px 20px',
                    backgroundColor: '#333',
                    color: '#fff',
                    textDecoration: 'none',
                    borderRadius: '4px'
                }}>
                    Return to List
                </Link>
            </div>

            {/* Animation Overlay */}
            {isSimulating && simOrder && (
                <div className="modal-overlay" style={{
                    background: 'rgba(0,0,0,0.95)',
                    position: 'fixed',
                    top: 0, left: 0, right: 0, bottom: 0,
                    zIndex: 9999,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '20px'
                }}>
                    <h2 style={{ color: '#fff', marginBottom: '10px', textAlign: 'center' }}>
                        レース進行（3Dシミュレーション: {simMode === 'physics' ? 'Physics' : 'Visual'}）
                    </h2>

                    <RaceAnimation3D
                        horses={race.horses}
                        finishOrder={simOrder}
                        courseStr={race.course}
                        venue={race.venue}
                        baba={race.baba}
                        weather={race.weather}
                        mode={simMode}
                        onClose={() => { setIsSimulating(false); setSimOrder(null); }}
                        onFinish={() => { setIsSimulating(false); setSimOrder(null); }}
                    />
                </div>
            )}
        </div>
    );
}
function GetRiskColor(risk: string) {
    if (risk === 'Low') return '#4caf50';
    if (risk === 'Medium') return '#ff9800';
    return '#f44336';
}
