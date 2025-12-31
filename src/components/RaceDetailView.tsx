'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Race, Horse } from '@/lib/types';
import RaceAnimation3D from './RaceAnimation3D';

export default function RaceDetailView({ race }: { race: Race }) {
    const [simResult, setSimResult] = useState<Horse | null>(null);
    const [isSimulating, setIsSimulating] = useState(false);

    const startSimulation = () => {
        // Enhanced Probabilistic Simulation using Plackett-Luce-like weighted selection
        const simScores: { horse: Horse; score: number }[] = race.horses.map(h => {
            let score = h.estimatedProb;

            // Random condition factor (80% to 120% of base)
            const conditionFactor = 0.8 + Math.random() * 0.4;
            score *= conditionFactor;

            // Upset Factor (null-safe odds check)
            const odds = h.odds ?? 0;
            if (odds > 20) {
                const upsetBonus = Math.random() * Math.random() * 0.3;
                score += upsetBonus;
            } else if (odds > 10) {
                const upsetBonus = Math.random() * Math.random() * 0.15;
                score += upsetBonus;
            }

            score += (Math.random() - 0.5) * 0.1;
            return { horse: h, score: Math.max(0.001, score) };
        });

        const totalScore = simScores.reduce((sum, s) => sum + s.score, 0);
        simScores.forEach(s => s.score = s.score / totalScore);

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

    // Parse race date
    let isPast = false;
    let dataLabel = 'Real-time';

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

    // Helper for displaying nullable values
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
                    gap: '15px',
                    flexWrap: 'wrap'
                }}>
                    <span>
                        📊 Acquired at: <span style={{ color: '#fff' }}>
                            {race.scrapedAt || '取得不可'}
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

            {/* Analysis Notes (Warnings) */}
            {race.analysis?.notes && race.analysis.notes.length > 0 && (
                <div className="glass" style={{ padding: '12px 16px', marginBottom: '20px', borderLeft: '4px solid #ff9800' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: 6 }}>⚠️ データ取得/推定の注意</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {race.analysis.notes.map((n, i) => <li key={i} style={{ color: '#ccc' }}>{n}</li>)}
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
                            <th style={{ width: '25%' }}>Factors (3 Pts)</th>
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
                                        {h.weightChange !== null && (
                                            <span style={{
                                                marginLeft: '5px',
                                                color: Math.abs(h.weightChange) >= 10 ? '#ff4444' : '#aaa'
                                            }}>
                                                ({h.weightChange > 0 ? '+' : ''}{h.weightChange})
                                            </span>
                                        )}
                                    </div>
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
                                    color: (h.ev ?? -1) > 0 ? '#4caf50' : (h.ev ?? -1) > -0.1 ? '#fff' : '#ff4444',
                                    fontWeight: (h.ev ?? -1) > 0 ? 'bold' : 'normal'
                                }}>
                                    {displayEv(h.ev)}
                                </td>
                                <td>
                                    {h.factors.map((f, fi) => (
                                        <span key={fi} style={{
                                            display: 'inline-block',
                                            background: 'rgba(255,255,255,0.1)',
                                            padding: '2px 6px',
                                            borderRadius: '3px',
                                            marginRight: '4px',
                                            marginBottom: '2px',
                                            fontSize: '0.8rem'
                                        }}>
                                            {f}
                                        </span>
                                    ))}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <div style={{ marginTop: '20px', fontSize: '0.8rem', color: '#666', textAlign: 'right' }}>
                    * EV = (Estimated Prob × Odds) - 1. Positive EV suggests value bet.
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
                                                <span style={{ fontSize: '0.8rem', color: '#888' }}>
                                                    ¥{tip.stakeYen?.toLocaleString() ?? '?'}
                                                </span>
                                            </div>
                                            <div style={{ fontSize: '0.8rem', color: '#aaa', marginBottom: '5px' }}>
                                                {tip.reason}
                                            </div>
                                            {(tip.prob != null || tip.ev != null) && (
                                                <div style={{ fontSize: '0.75rem', color: '#666' }}>
                                                    {tip.prob != null && <span>確率: {(tip.prob * 100).toFixed(1)}% </span>}
                                                    {tip.ev != null && (
                                                        <span style={{ color: tip.ev > 0 ? '#4caf50' : '#ff4444' }}>
                                                            EV: {(tip.ev * 100).toFixed(1)}%
                                                        </span>
                                                    )}
                                                </div>
                                            )}
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
                    <RaceAnimation3D
                        horses={race.horses}
                        winner={simResult}
                        courseStr={race.course}
                        onClose={() => setIsSimulating(false)}
                        onFinish={() => setIsSimulating(false)}
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
