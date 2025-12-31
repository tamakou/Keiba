'use client';
import { useEffect, useRef, useState } from 'react';
import { Horse } from '@/lib/types';

interface RaceAnimationProps {
    horses: Horse[];
    winner: Horse;
    courseStr: string;
    onFinish: () => void;
    onClose?: () => void;
}

interface RunnerState {
    horse: Horse;
    dist: number;
    lane: number;
    color: string;
    finishOrderFactor: number;
    finished: boolean;
}

export default function RaceAnimation3D({ horses, winner, courseStr, onFinish, onClose }: RaceAnimationProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const requestRef = useRef<number | null>(null);
    const runnersRef = useRef<RunnerState[]>([]);
    const rankingsRef = useRef<Horse[]>([]);

    const [showStart, setShowStart] = useState(true);
    const [rankings, setRankings] = useState<Horse[]>([]);
    const [raceEnded, setRaceEnded] = useState(false);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Track Config
        let totalDistance = 1600;
        const distMatch = courseStr.match(/([0-9]+)m/);
        if (distMatch) totalDistance = parseInt(distMatch[1]);

        // Track geometry in world coordinates
        const trackWidth = 300;
        const trackDepth = 150;
        const R = trackDepth / 2;
        const straightLen = trackWidth - trackDepth;
        const trackPerimeter = 2 * straightLen + 2 * Math.PI * R;

        // Get 3D position on track (x = left-right, y = up, z = depth/forward)
        const getTrackPos3D = (d: number, lane: number) => {
            const dNorm = (d / totalDistance) * trackPerimeter;
            const laneOffset = lane * 2.5;
            const innerR = R - laneOffset;

            // Bottom straight (near, moving right)
            if (dNorm < straightLen) {
                return { x: -straightLen / 2 + dNorm, y: 0, z: innerR };
            }
            let rem = dNorm - straightLen;

            // Right turn (going away)
            const halfCircle = Math.PI * R;
            if (rem < halfCircle) {
                const angle = (rem / halfCircle) * Math.PI;
                return {
                    x: straightLen / 2 + Math.sin(angle) * innerR,
                    y: 0,
                    z: Math.cos(angle) * innerR
                };
            }
            rem -= halfCircle;

            // Top straight (far, moving left)
            if (rem < straightLen) {
                return { x: straightLen / 2 - rem, y: 0, z: -innerR };
            }
            rem -= straightLen;

            // Left turn (coming back)
            const angle = (rem / halfCircle) * Math.PI;
            return {
                x: -straightLen / 2 - Math.sin(angle) * innerR,
                y: 0,
                z: -Math.cos(angle) * innerR
            };
        };

        // 3D to 2D Projection (Perspective)
        // Camera positioned more overhead to see entire track
        const camX = 0;
        const camY = 300; // Higher for more overhead view
        const camZ = 250; // Further back
        const fov = 450; // Balanced FOV

        const project3D = (x: number, y: number, z: number, W: number, H: number) => {
            // Translate relative to camera
            const dx = x - camX;
            const dy = y - camY;
            const dz = z - camZ;

            // Simple perspective (camera looks toward origin)
            const depth = -dz; // Positive depth = further from camera
            if (depth <= 10) return null;

            const scale = fov / depth;
            return {
                x: W / 2 + dx * scale,
                y: H / 3 - dy * scale, // Position track in upper third
                scale: scale,
                depth: depth
            };
        };

        // Init Runners
        const wakuColors = ['#fff', '#333', '#c9242b', '#1e7eb6', '#d6c526', '#2a9235', '#d4590f', '#d985a8'];
        runnersRef.current = horses.map((h) => ({
            horse: h,
            dist: 0,
            lane: h.gate - 1,
            color: wakuColors[(h.gate - 1) % 8] || '#888',
            finishOrderFactor: h.number === winner.number ? 1.08 : (0.92 + Math.random() * 0.12),
            finished: false
        }));
        rankingsRef.current = [];

        let startTime = performance.now();
        const duration = 22000;
        const speedScale = totalDistance / (duration / 16.6);
        let allFinished = false;

        const loop = (time: number) => {
            const elapsed = time - startTime;

            if (elapsed > 2000 && showStart) {
                setShowStart(false);
            }

            // Physics
            if (elapsed >= 2000 && !allFinished) {
                runnersRef.current.forEach(r => {
                    if (r.finished) return;
                    let s = speedScale * r.finishOrderFactor;
                    s += Math.sin(elapsed * 0.008 + r.lane * 0.5) * 0.15;
                    if (r.dist > totalDistance * 0.85 && r.horse.number === winner.number) s *= 1.08;
                    r.dist = Math.min(r.dist + s, totalDistance);

                    if (r.dist >= totalDistance && !r.finished) {
                        r.finished = true;
                        rankingsRef.current.push(r.horse);
                        setRankings([...rankingsRef.current]);
                    }
                });

                if (runnersRef.current.every(r => r.finished)) {
                    allFinished = true;
                    setRaceEnded(true);
                    // Disable auto-close to show results
                    // setTimeout(onFinish, 3000); 
                }
            }

            // Canvas sizing
            if (containerRef.current) {
                canvas.width = containerRef.current.clientWidth;
                canvas.height = containerRef.current.clientHeight;
            }
            const W = canvas.width;
            const H = canvas.height;

            // Sky gradient
            const grad = ctx.createLinearGradient(0, 0, 0, H);
            grad.addColorStop(0, '#1a1a2e');
            grad.addColorStop(0.5, '#16213e');
            grad.addColorStop(1, '#0f3460');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, W, H);

            // Draw Track Surface (3D)
            // Draw filled track as a series of quads
            ctx.fillStyle = '#8B4513';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;

            // Outer rail
            ctx.beginPath();
            let first = true;
            for (let d = 0; d <= trackPerimeter; d += 3) {
                const pos = getTrackPos3D((d / trackPerimeter) * totalDistance, -1);
                const p = project3D(pos.x, 0, pos.z, W, H);
                if (p) {
                    if (first) { ctx.moveTo(p.x, p.y); first = false; }
                    else ctx.lineTo(p.x, p.y);
                }
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Inner grass
            ctx.fillStyle = '#228B22';
            ctx.beginPath();
            first = true;
            for (let d = 0; d <= trackPerimeter; d += 3) {
                const pos = getTrackPos3D((d / trackPerimeter) * totalDistance, 10);
                const p = project3D(pos.x, 0, pos.z, W, H);
                if (p) {
                    if (first) { ctx.moveTo(p.x, p.y); first = false; }
                    else ctx.lineTo(p.x, p.y);
                }
            }
            ctx.closePath();
            ctx.fill();

            // Finish Line
            const fl1 = getTrackPos3D(0, -1);
            const fl2 = getTrackPos3D(0, 10);
            const pfl1 = project3D(fl1.x, 0, fl1.z, W, H);
            const pfl2 = project3D(fl2.x, 0, fl2.z, W, H);
            if (pfl1 && pfl2) {
                ctx.strokeStyle = '#FFD700';
                ctx.lineWidth = 6;
                ctx.beginPath();
                ctx.moveTo(pfl1.x, pfl1.y);
                ctx.lineTo(pfl2.x, pfl2.y);
                ctx.stroke();
            }

            // Draw Horses (sorted by depth for proper overlap)
            const horseData = runnersRef.current
                .filter(r => !r.finished)
                .map(r => {
                    const pos = getTrackPos3D(r.dist, r.lane);
                    const p = project3D(pos.x, 3, pos.z, W, H);
                    return { r, pos, p };
                })
                .filter(d => d.p !== null)
                .sort((a, b) => b.p!.depth - a.p!.depth);

            horseData.forEach(({ r, p }) => {
                if (!p) return;
                const size = Math.max(8, 18 * p.scale);

                // Shadow
                ctx.fillStyle = 'rgba(0,0,0,0.5)';
                ctx.beginPath();
                ctx.ellipse(p.x, p.y + size / 2, size, size / 3, 0, 0, Math.PI * 2);
                ctx.fill();

                // Horse body (3D diamond shape)
                ctx.fillStyle = r.color;
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(p.x, p.y - size);
                ctx.lineTo(p.x + size * 0.7, p.y);
                ctx.lineTo(p.x, p.y + size * 0.5);
                ctx.lineTo(p.x - size * 0.7, p.y);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

                // Number
                ctx.fillStyle = r.color === '#fff' || r.color === '#d6c526' ? '#000' : '#fff';
                ctx.font = `bold ${Math.max(10, size * 0.8)}px Arial`;
                ctx.textAlign = 'center';
                ctx.fillText(r.horse.number.toString(), p.x, p.y + 5);

                // Name
                if (size > 12) {
                    ctx.fillStyle = '#fff';
                    ctx.strokeStyle = '#000';
                    ctx.lineWidth = 3;
                    ctx.font = `bold ${Math.max(9, size * 0.6)}px Arial`;
                    const name = r.horse.name.substring(0, 5);
                    ctx.strokeText(name, p.x, p.y - size - 5);
                    ctx.fillText(name, p.x, p.y - size - 5);
                }
            });

            if (!allFinished || elapsed < startTime + duration + 5000) {
                requestRef.current = requestAnimationFrame(loop);
            }
        };

        requestRef.current = requestAnimationFrame(loop);

        return () => {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
        };
    }, [horses, winner, courseStr, onFinish, showStart]);

    return (
        <div ref={containerRef} style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            minHeight: '400px',
            background: '#0f0f23',
            borderRadius: '8px',
            overflow: 'hidden'
        }}>
            <canvas ref={canvasRef} style={{ display: 'block' }} />

            {showStart && (
                <div style={{
                    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    fontSize: '5rem', fontWeight: 'bold', color: '#FFD700', textShadow: '0 0 30px #FF4500'
                }}>
                    🏇 START 🏇
                </div>
            )}

            <div style={{
                position: 'absolute', top: '15px', right: '15px',
                background: 'rgba(0,0,0,0.85)', padding: '15px 20px', borderRadius: '10px',
                color: '#fff', minWidth: '180px', maxHeight: '50%', overflowY: 'auto',
                border: '2px solid #FFD700'
            }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.1rem', borderBottom: '2px solid #FFD700', paddingBottom: '8px', marginBottom: '10px' }}>
                    🏆 ランキング
                </div>
                {rankings.length === 0 ? (
                    <div style={{ color: '#aaa', fontSize: '1rem' }}>レーシング...</div>
                ) : (
                    rankings.map((h, i) => (
                        <div key={h.number} style={{
                            fontSize: '1rem',
                            color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : '#fff',
                            fontWeight: i < 3 ? 'bold' : 'normal',
                            marginBottom: '5px'
                        }}>
                            {i + 1}位 {h.name} (#{h.number})
                        </div>
                    ))
                )}
            </div>

            {raceEnded && (
                <div style={{
                    position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
                    background: 'rgba(0,0,0,0.85)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    zIndex: 100
                }}>
                    <div style={{
                        background: '#1a1a2e', padding: '30px', borderRadius: '15px',
                        border: '2px solid #FFD700', minWidth: '400px', maxWidth: '90%',
                        textAlign: 'center', maxHeight: '80%', overflowY: 'auto'
                    }}>
                        <h2 style={{ color: '#FFD700', fontSize: '2rem', marginBottom: '20px', textShadow: '0 0 10px #FFD700' }}>
                            🏁 RACE RESULT 🏁
                        </h2>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '30px' }}>
                            {rankings.map((h, i) => (
                                <div key={h.number} style={{
                                    display: 'flex', alignItems: 'center',
                                    padding: '10px',
                                    background: i === 0 ? 'linear-gradient(90deg, #FFD700 0%, #B8860B 100%)' : 'rgba(255,255,255,0.1)',
                                    borderRadius: '8px',
                                    transform: i === 0 ? 'scale(1.05)' : 'none',
                                    border: i === 0 ? '2px solid #fff' : 'none'
                                }}>
                                    <div style={{
                                        width: '40px', fontSize: '1.5rem', fontWeight: 'bold',
                                        color: i === 0 ? '#000' : '#fff'
                                    }}>
                                        {i + 1}
                                    </div>
                                    <div style={{ flex: 1, textAlign: 'left', marginLeft: '10px' }}>
                                        <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: i === 0 ? '#000' : '#fff' }}>
                                            {h.name}
                                        </div>
                                        <div style={{ fontSize: '0.8rem', color: i === 0 ? '#333' : '#aaa' }}>
                                            Gate: {h.gate} / No: {h.number}
                                        </div>
                                    </div>
                                    {i === 0 && <div style={{ fontSize: '2rem' }}>🥇</div>}
                                    {i === 1 && <div style={{ fontSize: '1.5rem' }}>🥈</div>}
                                    {i === 2 && <div style={{ fontSize: '1.5rem' }}>🥉</div>}
                                </div>
                            ))}
                        </div>

                        <button
                            onClick={onFinish}
                            style={{
                                padding: '15px 40px',
                                fontSize: '1.2rem',
                                fontWeight: 'bold',
                                background: '#FFD700',
                                color: '#000',
                                border: 'none',
                                borderRadius: '30px',
                                cursor: 'pointer',
                                transition: 'transform 0.2s',
                                boxShadow: '0 0 20px rgba(255, 215, 0, 0.4)'
                            }}
                            onMouseOver={e => e.currentTarget.style.transform = 'scale(1.05)'}
                            onMouseOut={e => e.currentTarget.style.transform = 'scale(1.0)'}
                        >
                            Close
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
