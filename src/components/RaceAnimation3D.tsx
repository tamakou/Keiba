'use client';
import { useEffect, useRef, useState } from 'react';
import { Horse } from '@/lib/types';
import { parseRaceCourse, normalizeBaba } from '@/lib/courseParse';

export type SimMode = 'visual' | 'physics';

interface RaceAnimationProps {
    horses: Horse[];
    finishOrder: Horse[]; // visualモード用（physicsでは無視可）
    courseStr: string;
    venue?: string;
    baba?: string;
    weather?: string;
    mode?: SimMode; // default 'visual'
    onFinish: () => void;
    onClose?: () => void;
}

interface RunnerState {
    horse: Horse;
    dist: number;
    lane: number;
    color: string;
    finished: boolean;

    // Visual用
    finishRank: number; // Added finishRank
    finishTimeMs: number;
    visualStyle: number;
    breakDelayMs: number;
    phase: number;

    // Physics用
    speed: number;       // 現在速度 (m/s)
    maxSpeed: number;    // トップスピード能力
    stamina: number;     // スタミナ (0-100)
    guts: number;        // 根性 (競り合い時の加速)
    accel: number;       // 加速力
    spurt: boolean;      // スパート中か
    currentLaneTarget: number; // 目標レーン
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function clamp11(x: number) { return Math.max(-1, Math.min(1, x)); }
function smoothstep(a: number, b: number, x: number) {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
}
function hashInt(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}

function inferStyleFromLast5(h: Horse): number {
    const runs = h.last5 || [];
    const pos: number[] = [];
    for (const r of runs) {
        const ptxt = (r?.passing || '') as string;
        const m = ptxt.match(/^(\d{1,2})/);
        if (!m) continue;
        const p = parseInt(m[1], 10);
        if (Number.isFinite(p)) pos.push(p);
    }
    if (pos.length === 0) return (Math.random() * 2 - 1) * 0.3;

    const avg = pos.reduce((a, b) => a + b, 0) / pos.length;
    if (avg <= 3) return -0.8;   // 逃げ
    if (avg <= 6) return -0.4;   // 先行
    if (avg <= 10) return +0.1;  // 中団
    return +0.7;                 // 差し/追込
}

export default function RaceAnimation3D({
    horses, finishOrder, courseStr, venue, baba, weather, mode = 'visual', onFinish
}: RaceAnimationProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const requestRef = useRef<number | null>(null);

    const runnersRef = useRef<RunnerState[]>([]);

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

        // ---- course meta ----
        const parsed = parseRaceCourse(courseStr);
        const surface = parsed.surface;
        const direction = parsed.direction;
        const totalDistance = parsed.distance ?? 1600;
        const isStraight = direction === '直' || (courseStr || '').includes('直線');

        const babaN = normalizeBaba(baba);
        const babaDrag = babaN === '稍' ? 0.995 : babaN === '重' ? 0.98 : babaN === '不' ? 0.96 : 1.0;

        // ---- unique-ish track per venue ----
        const v = venue || 'unknown';
        const vh = Math.abs(hashInt(v));
        const vW = 0.92 + (vh % 21) / 100;
        const vD = 0.92 + ((vh * 7) % 21) / 100;

        const scale = Math.sqrt(Math.max(0.6, Math.min(2.0, totalDistance / 1600)));
        const baseW = isStraight ? 540 : 320;
        const baseD = isStraight ? 120 : 170;
        const trackWidth = baseW * scale * vW;
        const trackDepth = baseD * scale * vD;
        const R = trackDepth / 2;
        const straightLen = Math.max(30, trackWidth - trackDepth);
        const trackPerimeter = isStraight ? trackWidth : (2 * straightLen + 2 * Math.PI * R);

        // ---- Visual Mode Param Calc ----
        const n = horses.length;
        const rankByNo = new Map<number, number>();
        if (finishOrder) finishOrder.forEach((h, idx) => rankByNo.set(h.number, idx));

        // 見た目用タイム推定
        const baseMs = Math.max(12000, Math.min(28000, 7000 + totalDistance * 6));
        const finishTimeByRank: number[] = [];
        let tObs = baseMs + (Math.random() - 0.5) * 500;
        for (let r = 0; r < n; r++) {
            finishTimeByRank[r] = tObs;
            tObs += Math.max(50, 70 + (r / n) * 20);
        }
        const maxFinishMs = finishTimeByRank[n - 1] ?? (baseMs + 1800);

        const wakuColors = ['#fff', '#333', '#c9242b', '#1e7eb6', '#d6c526', '#2a9235', '#d4590f', '#d985a8'];

        // Initialize Runners
        runnersRef.current = horses.map((h, idx) => {
            // Visual params
            const rank = rankByNo.get(h.number);
            const safeRank = (rank != null) ? rank : idx; // fallback
            const finishTimeMs = finishTimeByRank[safeRank] ?? maxFinishMs;

            const styleBase = inferStyleFromLast5(h);
            const style = clamp11(styleBase + (Math.random() - 0.5) * 0.20);
            const breakDelayMs = Math.max(0, Math.min(140, 40 + (Math.random() - 0.5) * 80));

            // Physics params (normalized)
            // 推定勝率やオッズが高いほど能力高く設定
            const prob = h.estimatedProb || (h.odds ? 1 / h.odds : 0.05);
            const strength = 0.8 + clamp01(prob * 5) * 0.4; // 0.8 ~ 1.2
            const maxSpeed = (16 + (Math.random() * 2)) * strength * babaDrag; // 16~18 m/s base

            return {
                horse: h,
                dist: 0,
                lane: h.gate - 1,
                color: wakuColors[(h.gate - 1) % 8] || '#888',
                finished: false,
                finishRank: safeRank,
                finishTimeMs,
                visualStyle: style,
                breakDelayMs,
                phase: Math.random() * Math.PI * 2,

                // Physics
                speed: 0,
                maxSpeed,
                stamina: 100 * strength,
                guts: 0.5 + Math.random() * 0.5,
                accel: 0.5 + Math.random() * 0.5,
                spurt: false,
                currentLaneTarget: h.gate - 1,
            };
        });

        const getTrackPos3D = (d: number, lane: number) => {
            const laneOffset = lane * 2.2;
            if (isStraight) {
                const x = -trackWidth / 2 + (d / totalDistance) * trackWidth;
                const z = -trackDepth / 2 + laneOffset;
                return { x, y: 0, z };
            }
            const dNorm = (d / totalDistance) * trackPerimeter;
            const innerR = Math.max(10, R - laneOffset);
            if (dNorm < straightLen) return { x: -straightLen / 2 + dNorm, y: 0, z: innerR };
            let rem = dNorm - straightLen;
            const halfCircle = Math.PI * R;
            if (rem < halfCircle) {
                const angle = (rem / halfCircle) * Math.PI;
                return { x: straightLen / 2 + Math.sin(angle) * innerR, y: 0, z: Math.cos(angle) * innerR };
            }
            rem -= halfCircle;
            if (rem < straightLen) return { x: straightLen / 2 - rem, y: 0, z: -innerR };
            rem -= straightLen;
            const angle = (rem / halfCircle) * Math.PI;
            return { x: -straightLen / 2 - Math.sin(angle) * innerR, y: 0, z: -Math.cos(angle) * innerR };
        };

        const scaleVal = scale;
        const camX = 0;
        const camY = 260 * scaleVal + 110;
        const camZ = 220 * scaleVal + 80;
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

        let startTime = performance.now();
        const startDelayMs = 1400;
        let startOverlayActive = true;
        let allFinished = false;
        let lastUiUpdate = 0;
        const uiUpdateIntervalMs = 220;
        let lastFrameTime = startTime;

        // Physics loop finish orders
        const physicsFinishOrder: Horse[] = [];

        const loop = (currentTime: number) => {
            const dt = Math.min(100, currentTime - lastFrameTime) / 1000; // sec
            lastFrameTime = currentTime;
            const elapsed = currentTime - startTime;

            if (elapsed > startDelayMs && startOverlayActive) {
                startOverlayActive = false;
                setShowStart(false);
            }

            const raceMs = elapsed - startDelayMs;

            if (raceMs >= 0 && !allFinished) {
                if (mode === 'visual') {
                    // ---- VISUAL MODE (Pre-determined) ----
                    const commonTimeMs = baseMs * 1.02;
                    runnersRef.current.forEach(r => {
                        if (r.finished) return;
                        const eff = raceMs - r.breakDelayMs;
                        if (eff <= 0) { r.dist = 0; return; }
                        if (eff >= r.finishTimeMs) {
                            r.dist = totalDistance;
                            r.finished = true;
                            return;
                        }
                        const progressCurve = (u: number, style: number) => {
                            const s = clamp11(style);
                            const k = 1.25 + 0.55 * Math.abs(s);
                            if (s >= 0) return Math.pow(u, k);
                            return 1 - Math.pow(1 - u, k);
                        };
                        const uHorse = clamp01(eff / r.finishTimeMs);
                        const uCommon = clamp01(eff / commonTimeMs);
                        const pack = smoothstep(0.08, 0.60, uCommon);
                        const frac = (1 - pack) * uCommon + pack * progressCurve(uHorse, r.visualStyle);
                        const wobble = (1 - pack) * 0.006 * Math.sin((eff / 240) + r.phase);
                        r.dist = Math.max(r.dist, clamp01(frac + wobble) * totalDistance);
                    });
                } else {
                    // ---- PHYSICS MODE (Parametric) ----
                    runnersRef.current.forEach(r => {
                        if (r.finished) return;

                        // Start gate
                        if (r.dist === 0 && raceMs < r.breakDelayMs) return;

                        // Acceleration
                        const targetBaseSpeed = r.maxSpeed * (r.stamina > 20 ? 1.0 : 0.7);
                        let targetSpeed = targetBaseSpeed;

                        // Position logic (Slight random lane change)
                        if (Math.random() < 0.02) r.currentLaneTarget += (Math.random() - 0.5) * 0.5;
                        r.currentLaneTarget = Math.max(0, Math.min(16, r.currentLaneTarget));
                        r.lane += (r.currentLaneTarget - r.lane) * dt * 0.5;

                        // Pace logic (Stamina management)
                        const u = r.dist / totalDistance;
                        if (u < 0.2) targetSpeed *= 0.95; // 序盤抑える
                        else if (u > 0.8) {
                            r.spurt = true;
                            targetSpeed *= 1.05 + r.guts * 0.1; // スパート
                        }

                        // Fatigue
                        r.stamina -= dt * (r.speed / r.maxSpeed) * 5;

                        // Accel
                        const dv = (targetSpeed - r.speed);
                        r.speed += dv * dt * r.accel;

                        // Move
                        r.dist += r.speed * dt;

                        if (r.dist >= totalDistance) {
                            r.dist = totalDistance;
                            r.finished = true;
                            physicsFinishOrder.push(r.horse);
                        }
                    });
                }

                if (currentTime - lastUiUpdate >= uiUpdateIntervalMs) {
                    const live = [...runnersRef.current].slice().sort((a, b) => b.dist - a.dist).map(x => x.horse);
                    setRankings(live);
                    lastUiUpdate = currentTime;
                }

                const activeCnt = runnersRef.current.filter(r => !r.finished).length;
                if (activeCnt === 0) {
                    allFinished = true;
                    // In physics mode, use the actual finish order. In visual, use pre-determined.
                    const finalRanks = (mode === 'physics') ? physicsFinishOrder : (finishOrder || []);
                    setRankings([...finalRanks]);
                    setRaceEnded(true);
                }
            }

            // Drawing
            if (containerRef.current) {
                canvas.width = containerRef.current.clientWidth;
                canvas.height = containerRef.current.clientHeight;
            }
            const W = canvas.width;
            const H = canvas.height;
            const isRainy = weather && (weather.includes('雨') || weather.includes('Rain'));
            const grad = ctx.createLinearGradient(0, 0, 0, H);
            if (isRainy) {
                grad.addColorStop(0, '#1a1a2e');
                grad.addColorStop(1, '#1e272e');
            } else {
                grad.addColorStop(0, '#0b1020');
                grad.addColorStop(1, '#0a1228');
            }
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, W, H);

            // Rain
            if (isRainy) {
                ctx.strokeStyle = 'rgba(200, 200, 255, 0.3)';
                ctx.beginPath();
                for (let i = 0; i < 40; i++) {
                    const rx = (Math.random() * W + currentTime * 0.5) % W;
                    const ry = (Math.random() * H + currentTime * 2.0) % H;
                    ctx.moveTo(rx, ry); ctx.lineTo(rx - 2, ry + 10);
                }
                ctx.stroke();
            }

            // Track
            const trackColor = surface === '芝' ? '#2E7D32' : '#8B4513';
            const infieldColor = surface === '芝' ? '#1B5E20' : '#228B22';
            ctx.strokeStyle = '#fff';
            if (isStraight) {
                // ... straight drawing (simplified for brevity match) ...
                const p1 = project3D(-trackWidth / 2, 0, -trackDepth / 2, W, H);
                const p2 = project3D(trackWidth / 2, 0, -trackDepth / 2, W, H);
                const p3 = project3D(trackWidth / 2, 0, trackDepth / 2, W, H);
                const p4 = project3D(-trackWidth / 2, 0, trackDepth / 2, W, H);
                if (p1 && p2 && p3 && p4) {
                    ctx.fillStyle = trackColor;
                    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.fill(); ctx.stroke();
                }
            } else {
                ctx.fillStyle = trackColor;
                ctx.beginPath();
                for (let d = 0; d <= trackPerimeter; d += 5) {
                    const pos = getTrackPos3D((d / trackPerimeter) * totalDistance, -1);
                    const p = project3D(pos.x, 0, pos.z, W, H);
                    if (p) ctx.lineTo(p.x, p.y);
                }
                ctx.closePath(); ctx.fill(); ctx.stroke();
                ctx.fillStyle = infieldColor;
                ctx.beginPath();
                for (let d = 0; d <= trackPerimeter; d += 5) {
                    const pos = getTrackPos3D((d / trackPerimeter) * totalDistance, 10);
                    const p = project3D(pos.x, 0, pos.z, W, H);
                    if (p) ctx.lineTo(p.x, p.y);
                }
                ctx.closePath(); ctx.fill();
            }

            // Horses
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
                ctx.fillStyle = 'rgba(0,0,0,0.5)';
                ctx.beginPath();
                ctx.ellipse(p.x, p.y + size / 2, size, size / 3, 0, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = r.color;
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 1;
                ctx.beginPath();
                // Simple shape
                ctx.moveTo(p.x, p.y - size);
                ctx.lineTo(p.x + size * 0.6, p.y);
                ctx.lineTo(p.x, p.y + size * 0.5);
                ctx.lineTo(p.x - size * 0.6, p.y);
                ctx.fill(); ctx.stroke();

                ctx.fillStyle = '#fff';
                ctx.font = 'bold 10px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(r.horse.number.toString(), p.x, p.y + 4);
            });

            if (!allFinished) {
                requestRef.current = requestAnimationFrame(loop);
            }
        };

        requestRef.current = requestAnimationFrame(loop);
        return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
    }, [horses, finishOrder, courseStr, venue, baba, weather, mode]); // Add mode dependency

    return (
        <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%', minHeight: '400px', background: '#0f0f23', overflow: 'hidden' }}>
            <canvas ref={canvasRef} />
            {showStart && <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', fontSize: '4rem', color: '#FFD700', fontWeight: 'bold', textShadow: '0 0 30px #FF4500' }}>START</div>}

            {/* HUD */}
            <div style={{ position: 'absolute', top: 10, left: 10, color: '#fff', background: 'rgba(0,0,0,0.5)', padding: '5px 10px', borderRadius: 4 }}>
                <div>{venue} {courseStr}</div>
                <div>Mode: {mode === 'physics' ? 'Physics' : 'Replay'}</div>
                {weather && <div>Weather: {weather}</div>}
            </div>

            {/* Ranking Board */}
            <div style={{ position: 'absolute', top: 10, right: 10, width: 180, background: 'rgba(0,0,0,0.7)', padding: 10, color: '#fff', maxHeight: '60%', overflowY: 'auto' }}>
                <div style={{ borderBottom: '1px solid #777', marginBottom: 5 }}>Live Rank</div>
                {rankings.map((h, i) => (
                    <div key={h.number} style={{ fontSize: '0.9rem', color: i < 3 ? '#FFD700' : '#fff' }}>
                        {i + 1}. {h.name} (#{h.number})
                    </div>
                ))}
            </div>

            {raceEnded && (
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ background: '#222', padding: 30, border: '2px solid #FFD700', textAlign: 'center', color: '#fff', borderRadius: 10 }}>
                        <h2 style={{ color: '#FFD700' }}>GOAL!</h2>
                        <div style={{ margin: '20px 0', textAlign: 'left' }}>
                            {rankings.slice(0, 5).map((h, i) => (
                                <div key={h.number} style={{ padding: '5px 0', borderBottom: '1px solid #444' }}>
                                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.'} {h.name}
                                </div>
                            ))}
                        </div>
                        <button onClick={onFinish} style={{ padding: '10px 20px', background: '#FFD700', border: 'none', cursor: 'pointer', fontWeight: 'bold', borderRadius: 5 }}>Close</button>
                    </div>
                </div>
            )}
        </div>
    );
}
