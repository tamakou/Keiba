'use client';
import { useEffect, useRef, useState } from 'react';
import { Horse } from '@/lib/types';
import { parseRaceCourse } from '@/lib/courseParse';

interface RaceAnimationProps {
    horses: Horse[];
    finishOrder: Horse[]; // 1着→最下位
    courseStr: string;
    onFinish: () => void;
    onClose?: () => void;
}

interface RunnerState {
    horse: Horse;
    dist: number;
    lane: number;
    color: string;

    finishRank: number;    // 0=1着
    finishTimeMs: number;  // ゴールまでの時間
    style: number;         // -1..+1 先行(-)〜差し(+)
    phase: number;         // 微小ノイズ用

    finished: boolean;
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function clamp11(x: number) { return Math.max(-1, Math.min(1, x)); }
function smoothstep(a: number, b: number, x: number) {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
}

function inferStyleFromLast5(h: Horse): number {
    const runs = (h as any).last5 as any[] | null | undefined;
    if (!runs || runs.length === 0) return (Math.random() * 2 - 1) * 0.4;

    const pos: number[] = [];
    for (const r of runs) {
        const ptxt = (r?.passing || '') as string;
        const m = ptxt.match(/^(\d{1,2})/);
        if (!m) continue;
        const p = parseInt(m[1], 10);
        if (Number.isFinite(p)) pos.push(p);
    }
    if (pos.length === 0) return (Math.random() * 2 - 1) * 0.4;

    const avg = pos.reduce((a, b) => a + b, 0) / pos.length;
    if (avg <= 3) return -0.75;      // 逃げ
    if (avg <= 6) return -0.35;      // 先行
    if (avg <= 10) return +0.15;     // 中団
    return +0.65;                    // 差し/追込
}

export default function RaceAnimation3D({ horses, finishOrder, courseStr, onFinish }: RaceAnimationProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const requestRef = useRef<number | null>(null);

    const runnersRef = useRef<RunnerState[]>([]);
    const finishOrderRef = useRef<Horse[]>([]);

    const [showStart, setShowStart] = useState(true);
    const [rankings, setRankings] = useState<Horse[]>([]);
    const [raceEnded, setRaceEnded] = useState(false);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        if (!horses || horses.length === 0) return;

        setShowStart(true);
        setRankings([]);
        setRaceEnded(false);

        // ---- course parse (芝/ダ/距離/直線) ----
        const parsed = parseRaceCourse(courseStr);
        const surface = parsed.surface; // '芝' | 'ダ' | '障' | '不明'
        const direction = parsed.direction;
        let totalDistance = parsed.distance ?? 1600;

        const isStraight = direction === '直' || courseStr.includes('直線');
        const scale = Math.sqrt(Math.max(0.6, Math.min(2.0, totalDistance / 1600)));

        // ---- track geometry (距離でスケール変化) ----
        const baseW = isStraight ? 520 : 320;
        const baseD = isStraight ? 120 : 170;

        const trackWidth = baseW * scale;
        const trackDepth = baseD * scale;

        // camera
        const camX = 0;
        const camY = 260 * scale + 90;
        const camZ = 220 * scale + 70;
        const fov = 520;

        const project3D = (x: number, y: number, z: number, W: number, H: number) => {
            const dx = x - camX;
            const dy = y - camY;
            const dz = z - camZ;

            const depth = -dz;
            if (depth <= 10) return null;

            const s = fov / depth;
            return { x: W / 2 + dx * s, y: H / 3 - dy * s, scale: s, depth };
        };

        // path
        const R = trackDepth / 2;
        const straightLen = Math.max(30, trackWidth - trackDepth);
        const trackPerimeter = isStraight ? trackWidth : (2 * straightLen + 2 * Math.PI * R);

        const getTrackPos3D = (d: number, lane: number) => {
            const laneOffset = lane * 2.2; // 詰める
            const zLane = laneOffset;

            if (isStraight) {
                const x = -trackWidth / 2 + (d / totalDistance) * trackWidth;
                return { x, y: 0, z: zLane };
            }

            const dNorm = (d / totalDistance) * trackPerimeter;
            const innerR = Math.max(10, R - laneOffset);

            // bottom straight (near)
            if (dNorm < straightLen) {
                return { x: -straightLen / 2 + dNorm, y: 0, z: innerR };
            }
            let rem = dNorm - straightLen;

            // right turn
            const halfCircle = Math.PI * R;
            if (rem < halfCircle) {
                const angle = (rem / halfCircle) * Math.PI;
                return { x: straightLen / 2 + Math.sin(angle) * innerR, y: 0, z: Math.cos(angle) * innerR };
            }
            rem -= halfCircle;

            // top straight (far)
            if (rem < straightLen) {
                return { x: straightLen / 2 - rem, y: 0, z: -innerR };
            }
            rem -= straightLen;

            // left turn
            const angle = (rem / halfCircle) * Math.PI;
            return { x: -straightLen / 2 - Math.sin(angle) * innerR, y: 0, z: -Math.cos(angle) * innerR };
        };

        // ---- finish order ----
        finishOrderRef.current = (finishOrder && finishOrder.length === horses.length) ? finishOrder.slice() : horses.slice();
        const rankByNo = new Map<number, number>();
        finishOrderRef.current.forEach((h, idx) => rankByNo.set(h.number, idx));

        // ---- finish time (着差を縮める) ----
        const n = horses.length;

        const baseMs = Math.max(12000, Math.min(26000, 7000 + totalDistance * 6));
        const surfaceAdj = surface === '芝' ? -250 : surface === 'ダ' ? +250 : 0;
        let t = baseMs + surfaceAdj + (Math.random() - 0.5) * 500; // winner

        const finishTimeByRank: number[] = [];
        for (let r = 0; r < n; r++) {
            finishTimeByRank[r] = t;
            // 60〜140msくらいの着差に（従来は180〜400msで離れすぎ）
            const gap = 85 + (r / Math.max(1, n - 1)) * 25 + (Math.random() - 0.5) * 40;
            t += Math.max(60, Math.min(140, gap));
        }
        const maxFinishMs = finishTimeByRank[n - 1] ?? (baseMs + 1600);

        // ---- progress curve（序盤は隊列が詰まる） ----
        const progressCurve = (u: number, style: number) => {
            const s = clamp11(style);
            // 先行は前半やや速い、差しは後半やや伸びる（極端にしない）
            const k = 1.25 + 0.55 * Math.abs(s); // 1.25..1.80
            if (s >= 0) return Math.pow(u, k);              // 差し：後半寄り
            return 1 - Math.pow(1 - u, k);                  // 先行：前半寄り
        };

        const trackColor = surface === '芝' ? '#2E7D32' : '#8B4513';
        const infieldColor = surface === '芝' ? '#1B5E20' : '#228B22';

        // ---- init runners ----
        const wakuColors = ['#fff', '#333', '#c9242b', '#1e7eb6', '#d6c526', '#2a9235', '#d4590f', '#d985a8'];

        runnersRef.current = horses.map((h) => {
            const rank = rankByNo.get(h.number);
            const safeRank = (rank != null && rank >= 0 && rank < n) ? rank : (n - 1);
            const finishTimeMs = finishTimeByRank[safeRank] ?? maxFinishMs;

            // last5由来の脚質（無ければ弱ランダム）
            const st = inferStyleFromLast5(h);
            const style = clamp11(st + (Math.random() - 0.5) * 0.20);

            return {
                horse: h,
                dist: 0,
                lane: h.gate - 1,
                color: wakuColors[(h.gate - 1) % 8] || '#888',
                finishRank: safeRank,
                finishTimeMs,
                style,
                phase: Math.random() * Math.PI * 2,
                finished: false
            };
        });

        // ---- loop ----
        let startTime = performance.now();
        const startDelayMs = 1400; // 少し短め
        let startOverlayActive = true;
        let allFinished = false;
        let lastUiUpdate = 0;
        const uiUpdateIntervalMs = 220;
        const stopAfterMs = startDelayMs + maxFinishMs + 5000;

        const finishDist = isStraight ? totalDistance : 0;

        const loop = (time: number) => {
            const elapsed = time - startTime;

            if (elapsed > startDelayMs && startOverlayActive) {
                startOverlayActive = false;
                setShowStart(false);
            }

            const raceMs = elapsed - startDelayMs;

            if (raceMs >= 0 && !allFinished) {
                runnersRef.current.forEach(r => {
                    if (r.finished) return;

                    if (raceMs >= r.finishTimeMs) {
                        r.dist = totalDistance;
                        r.finished = true;
                    } else {
                        const u = clamp01(raceMs / r.finishTimeMs);

                        // pack: 序盤はu(共通ペース)寄り、後半ほど脚質カーブが効く
                        const pack = smoothstep(0.05, 0.65, u);
                        const frac = (1 - pack) * u + pack * progressCurve(u, r.style);

                        // 微小な揺れ（隊列が崩れすぎないよう後半は弱く）
                        const wobble = (1 - pack) * 0.006 * Math.sin((raceMs / 240) + r.phase);

                        const targetDist = (clamp01(frac + wobble)) * totalDistance;
                        r.dist = Math.max(r.dist, targetDist);
                    }
                });

                if (time - lastUiUpdate >= uiUpdateIntervalMs) {
                    const live = [...runnersRef.current].slice().sort((a, b) => b.dist - a.dist).map(x => x.horse);
                    setRankings(live);
                    lastUiUpdate = time;
                }

                if (raceMs >= maxFinishMs) {
                    allFinished = true;
                    setRankings([...finishOrderRef.current]);
                    setRaceEnded(true);
                }
            }

            // sizing
            if (containerRef.current) {
                canvas.width = containerRef.current.clientWidth;
                canvas.height = containerRef.current.clientHeight;
            }
            const W = canvas.width;
            const H = canvas.height;

            // background
            const grad = ctx.createLinearGradient(0, 0, 0, H);
            grad.addColorStop(0, '#0b1020');
            grad.addColorStop(0.6, '#132044');
            grad.addColorStop(1, '#0a1228');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, W, H);

            // ---- draw track ----
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;

            if (isStraight) {
                // rectangle track
                const p1 = project3D(-trackWidth / 2, 0, -trackDepth / 2, W, H);
                const p2 = project3D(trackWidth / 2, 0, -trackDepth / 2, W, H);
                const p3 = project3D(trackWidth / 2, 0, trackDepth / 2, W, H);
                const p4 = project3D(-trackWidth / 2, 0, trackDepth / 2, W, H);

                if (p1 && p2 && p3 && p4) {
                    ctx.fillStyle = trackColor;
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.lineTo(p3.x, p3.y);
                    ctx.lineTo(p4.x, p4.y);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                }

                // finish line at end
                const fl1 = project3D(trackWidth / 2, 0, -trackDepth / 2, W, H);
                const fl2 = project3D(trackWidth / 2, 0, trackDepth / 2, W, H);
                if (fl1 && fl2) {
                    ctx.strokeStyle = '#FFD700';
                    ctx.lineWidth = 6;
                    ctx.beginPath();
                    ctx.moveTo(fl1.x, fl1.y);
                    ctx.lineTo(fl2.x, fl2.y);
                    ctx.stroke();
                }
            } else {
                // oval track outer
                ctx.fillStyle = trackColor;
                ctx.beginPath();
                let first = true;
                for (let d = 0; d <= trackPerimeter; d += 3) {
                    const pos = getTrackPos3D((d / trackPerimeter) * totalDistance, -1);
                    const p = project3D(pos.x, 0, pos.z, W, H);
                    if (!p) continue;
                    if (first) { ctx.moveTo(p.x, p.y); first = false; }
                    else ctx.lineTo(p.x, p.y);
                }
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

                // inner infield
                ctx.fillStyle = infieldColor;
                ctx.beginPath();
                first = true;
                for (let d = 0; d <= trackPerimeter; d += 3) {
                    const pos = getTrackPos3D((d / trackPerimeter) * totalDistance, 10);
                    const p = project3D(pos.x, 0, pos.z, W, H);
                    if (!p) continue;
                    if (first) { ctx.moveTo(p.x, p.y); first = false; }
                    else ctx.lineTo(p.x, p.y);
                }
                ctx.closePath();
                ctx.fill();

                // finish line
                const fl1 = getTrackPos3D(finishDist, -1);
                const fl2 = getTrackPos3D(finishDist, 10);
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
            }

            // ---- draw horses (depth sort) ----
            const horseData = runnersRef.current
                .filter(r => !r.finished)
                .map(r => {
                    const pos = getTrackPos3D(r.dist, r.lane);
                    const p = project3D(pos.x, 3, pos.z, W, H);
                    return { r, p };
                })
                .filter(d => d.p !== null)
                .sort((a, b) => (b.p as any).depth - (a.p as any).depth);

            horseData.forEach(({ r, p }) => {
                if (!p) return;
                const size = Math.max(8, 18 * p.scale);

                // shadow
                ctx.fillStyle = 'rgba(0,0,0,0.45)';
                ctx.beginPath();
                ctx.ellipse(p.x, p.y + size / 2, size, size / 3, 0, 0, Math.PI * 2);
                ctx.fill();

                // body
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

                // number
                ctx.fillStyle = r.color === '#fff' || r.color === '#d6c526' ? '#000' : '#fff';
                ctx.font = `bold ${Math.max(10, size * 0.8)}px Arial`;
                ctx.textAlign = 'center';
                ctx.fillText(r.horse.number.toString(), p.x, p.y + 5);
            });

            if (!allFinished || elapsed < stopAfterMs) {
                requestRef.current = requestAnimationFrame(loop);
            }
        };

        requestRef.current = requestAnimationFrame(loop);
        return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };

    }, [horses, finishOrder, courseStr]);

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
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
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
