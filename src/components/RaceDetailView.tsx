'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Race, Horse } from '@/lib/types';
import RaceAnimation3D from './RaceAnimation3D';

export default function RaceDetailView({ race }: { race: Race }) {
    const [simResult, setSimResult] = useState<Horse | null>(null);
    const [isSimulating, setIsSimulating] = useState(false);

    const startSimulation = () => {
        // Enhanced Probabilistic Simulation
        // Each simulation applies random "condition" modifiers to create varied outcomes

        // Step 1: Apply per-simulation random modifiers
        const simScores: { horse: Horse; score: number }[] = race.horses.map(h => {
            // Base: Estimated probability
            let score = h.estimatedProb;

            // Random condition factor (80% to 120% of base)
            const conditionFactor = 0.8 + Math.random() * 0.4;
            score *= conditionFactor;

            // Upset Factor: Lower-odds horses have higher variance (can overperform)
            // Higher odds = higher potential for upset
            if (h.odds > 20) {
                // Long shot: Can dramatically overperform (upset potential)
                const upsetBonus = Math.random() * Math.random() * 0.3; // 0-30% bonus (rare)
                score += upsetBonus;
            } else if (h.odds > 10) {
                // Mid-range: Moderate upset potential
                const upsetBonus = Math.random() * Math.random() * 0.15;
                score += upsetBonus;
            }

            // Pace/Position luck factor
            score += (Math.random() - 0.5) * 0.1;

            return { horse: h, score: Math.max(0.001, score) };
        });

        // Step 2: Normalize scores to probabilities for this simulation
        const totalScore = simScores.reduce((sum, s) => sum + s.score, 0);
        simScores.forEach(s => s.score = s.score / totalScore);

        // Step 3: Weighted random selection based on adjusted scores
        const r = Math.random();
        let cumulative = 0;
        let winner = race.horses[0];

        for (const { horse, score } of simScores) {
            cumulative += score;
            if (r <= cumulative) {
                winner = horse;
                break;
            }
        }

        setSimResult(winner);
        setIsSimulating(true);
    };

    const now = new Date();
    // Parse race date: YYYYMMDD
    let isPast = false;
    let dataLabel = 'Real-time';

    if (race.date) {
        const y = parseInt(race.date.substring(0, 4));
        const m = parseInt(race.date.substring(4, 6)) - 1;
        const d = parseInt(race.date.substring(6, 8));
        const raceDate = new Date(y, m, d);
        // Compare dates (ignore time)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (raceDate < today) {
            isPast = true;
            dataLabel = `Final Data (${race.date.substring(0, 4)}/${race.date.substring(4, 6)}/${race.date.substring(6, 8)})`;
        }
    }

    return (
        <div className="container" style={{ maxWidth: '1000px' }}>
            <div className="header" style={{ textAlign: 'left', marginBottom: '20px' }}>
                <Link href="/" style={{ color: '#888', textDecoration: 'none' }}>&larr; Back to List</Link>
                <h1 style={{ margin: '10px 0' }}>{race.name}</h1>
                <p className="race-meta">
                    {race.time} | {race.course} | Weather: {race.weather} | Baba: {race.baba}
                </p>
                <p style={{ fontSize: '0.9rem', color: isPast ? '#ffcc00' : '#666', marginTop: '5px' }}>
                    Status: {dataLabel} {isPast ? '(Final Odds)' : ''}
                </p>

                {/* Strict Data Source Display */}
                <div style={{
                    fontSize: '0.8rem',
                    color: '#888',
                    marginTop: '10px',
                    borderTop: '1px solid #333',
                    paddingTop: '5px',
                    display: 'flex',
                    gap: '15px'
                }}>
                    <span>
                        📊 Acquired at: <span style={{ color: '#fff' }}>
                            {race.scrapedAt ? `${new Date(race.scrapedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST` : '取得不可'}
                        </span>
                    </span>
                    <span>
                        Source: {race.sourceUrl ? <Link href={race.sourceUrl} target="_blank" style={{ color: '#4da6ff' }}>NetKeiba</Link> : '取得不可'}
                    </span>
                </div>
            </div>

            <div className="glass" style={{ padding: '20px', overflowX: 'auto' }}>
                <table className="detail-table">
                    <thead>
                        <tr>
                            <th>card</th>
                            <th>Horse</th>
                            <th>Jockey/Trainer</th>
                            <th>Odds (Imp%)</th>
                            <th>My Prob</th>
                            <th>EV</th>
                            <th style={{ width: '30%' }}>Model Reasoning (3 Pts)</th>
                        </tr>
                    </thead>
                    <tbody>
                        {race.horses.map((h, i) => (
                            <tr key={`${h.number}-${i}`}>
                                <td style={{ color: h.gate <= 2 ? '#fff' : '#888', fontWeight: 'bold' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span>{h.gate}-{h.number}</span>
                                    </div>
                                </td>
                                <td>
                                    <div style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{h.name}</div>
                                    <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
                                        {h.weight}
                                        {h.weightChange !== undefined && (
                                            <span style={{
                                                marginLeft: '5px',
                                                color: h.weightChange >= 10 || h.weightChange <= -10 ? '#ff4444' : '#aaa'
                                            }}>
                                                ({h.weightChange > 0 ? '+' : ''}{h.weightChange})
                                            </span>
                                        )}
                                    </div>
                                </td>
                                <td style={{ fontSize: '0.9rem' }}>
                                    <div>{h.jockey}</div>
                                    <div style={{ fontSize: '0.8rem', color: '#666' }}>{h.trainer}</div>
                                </td>
                                <td>
                                    <div style={{ fontWeight: 'bold', color: '#fff' }}>{h.odds.toFixed(1)}</div>
                                    <div style={{ fontSize: '0.8rem', color: '#aaa' }}>({(h.marketProb * 100).toFixed(1)}%)</div>
                                </td>
                                <td style={{ color: 'var(--primary)', fontWeight: 'bold', fontSize: '1.1rem' }}>{(h.estimatedProb * 100).toFixed(1)}%</td>
                                <td className={h.ev > 0 ? 'high-ev' : 'low-ev'}>
                                    {(h.ev * 100).toFixed(1)}%
                                </td>
                                <td style={{ fontSize: '0.85rem', textAlign: 'left' }}>
                                    <ul style={{ margin: 0, paddingLeft: '20px', listStyle: 'disc' }}>
                                        {h.factors.map(f => <li key={f} style={{ color: '#ccc' }}>{f}</li>)}
                                    </ul>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <div style={{ marginTop: '20px', fontSize: '0.8rem', color: '#666', textAlign: 'right' }}>
                    * EV = (Estimated Prob x Odds) - 1. High EV suggests value bet.
                    * Model uses simplified factors based on available data.
                </div>
            </div>

            <button className="sim-button" onClick={startSimulation} disabled={isSimulating}>
                {isSimulating ? 'Running Race...' : 'Start Simulation'}
            </button>

            {/* Betting Strategies */}
            {race.portfolios && (
                <div style={{ marginTop: '40px' }}>
                    <h2 style={{ marginBottom: '20px', borderBottom: '1px solid #444', paddingBottom: '10px' }}>
                        🎯 AI Betting Portfolios
                    </h2>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px' }}>
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
                                <p style={{ fontSize: '0.9rem', color: '#ccc', marginBottom: '15px', fontStyle: 'italic' }}>
                                    "{pf.description}"
                                </p>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                    {pf.tips.map((tip, i) => (
                                        <div key={i} style={{ backgroundColor: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '4px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                                                <span style={{ fontWeight: 'bold', color: '#ffcc00' }}>
                                                    【{tip.type}】 {tip.selection.join(tip.type.includes('連') || tip.type.includes('ワイド') ? '-' : '')}
                                                </span>
                                                <span style={{ fontSize: '0.8rem', color: '#888' }}>
                                                    Alloc: {tip.alloc}%
                                                </span>
                                            </div>
                                            <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
                                                {tip.reason}
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
            {isSimulating && simResult && (
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
                    <h2 style={{ color: '#fff', marginBottom: '10px', textAlign: 'center' }}>レース進行（3Dシミュレーション）</h2>
                    <div style={{ width: '100%', height: 'calc(100vh - 100px)', maxWidth: '1600px' }}>
                        <RaceAnimation3D
                            horses={race.horses}
                            winner={simResult}
                            courseStr={race.course}
                            onFinish={() => setIsSimulating(false)}
                        />
                    </div>
                </div>
            )}

            {/* Result Modal (Only after simulation finishes) */}
            {!isSimulating && simResult && (
                <div className="modal-overlay" onClick={() => setSimResult(null)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <div className="animate-in">
                            <h2 style={{ color: '#888', textTransform: 'uppercase', letterSpacing: '2px' }}>Winner</h2>
                            <div className="winner-text">{simResult.name}</div>
                            <div style={{ marginTop: '20px' }}>
                                <div style={{ fontSize: '1.2rem' }}>No. {simResult.number}</div>
                                <div style={{ color: '#888' }}>{simResult.jockey}</div>
                            </div>
                            <button
                                style={{ marginTop: '30px', background: 'transparent', border: '1px solid #444', color: '#fff', padding: '10px 30px', borderRadius: '20px', cursor: 'pointer' }}
                                onClick={() => setSimResult(null)}
                            >
                                Close
                            </button>
                        </div>
                    </div>
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
