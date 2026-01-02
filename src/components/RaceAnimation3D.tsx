'use client';
import { useEffect, useRef, useState } from 'react';
import { Horse } from '@/lib/types';
import { parseRaceCourse, normalizeBaba } from '@/lib/courseParse';

interface RaceAnimationProps {
    horses: Horse[];
    finishOrder: Horse[]; // 1着→最下位（サンプル着順）
    courseStr: string;
    venue?: string;
    baba?: string;
    weather?: string;
    onFinish: () => void;
    onClose?: () => void;
}

interface RunnerState {
    horse: Horse;
    dist: number;
    lane: number;
    color: string;

    finishRank: number;
    finishTimeMs: number;
    style: number;          // -1..+1 先行(-)〜差し(+)
    breakDelayMs: number;   // 出遅れ/反応差（小さく）
    phase: number;          // 揺れ用
    finished: boolean;
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
    horses, finishOrder, courseStr, venue, baba, weather, onFinish
}: RaceAnimationProps) {
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

        // ---- course meta ----
        const parsed = parseRaceCourse(courseStr);
        const surface = parsed.surface; // 芝/ダ/障/不明
        const direction = parsed.direction; // 右/左/直/不明
        const totalDistance = parsed.distance ?? 1600;
        const isStraight = direction === '直' || (courseStr || '').includes('直線');

        const babaN = normalizeBaba(baba);
        const babaAdj = babaN === '稍' ? 150 : babaN === '重' ? 350 : babaN === '不' ? 550 : 0;

        // ---- unique-ish track per venue (でも破綻しない範囲) ----
        const v = venue || 'unknown';
        const vh = Math.abs(hashInt(v));
        const vW = 0.92 + (vh % 21) / 100;           // 0.92..1.12
        const vD = 0.92 + ((vh * 7) % 21) / 100;     // 0.92..1.12

        // ---- geometry scale by distance ----
        const scale = Math.sqrt(Math.max(0.6, Math.min(2.0, totalDistance / 1600)));

        const baseW = isStraight ? 540 : 320;
        const baseD = isStraight ? 120 : 170;

        const trackWidth = baseW * scale * vW;
        const trackDepth = baseD * scale * vD;

        const R = trackDepth / 2;
        const straightLen = Math.max(30, trackWidth - trackDepth);
        const trackPerimeter = isStraight ? trackWidth : (2 * straightLen + 2 * Math.PI * R);

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

        // ---- camera ----
        const camX = 0;
        const camY = 260 * scale + 110;
        const camZ = 220 * scale + 80;
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

        // ---- finish order ----
        finishOrderRef.current = (finishOrder && finishOrder.length === horses.length) ? finishOrder.slice() : horses.slice();
        const rankByNo = new Map<number, number>();
        finishOrderRef.current.forEach((h, idx) => rankByNo.set(h.number, idx));

        // ---- finish time: 距離/馬場で変化 + 着差は小さめ ----
        const baseMs = Math.max(12000, Math.min(28000, 7000 + totalDistance * 6)) + babaAdj;
        const surfaceAdj = surface === '芝' ? -250 : surface === 'ダ' ? +250 : 0;

        const n = horses.length;
        const finishTimeByRank: number[] = [];
        let t = baseMs + surfaceAdj + (Math.random() - 0.5) * 500;

        // 1着→最下位に向けて、着差を縮める
        for (let r = 0; r < n; r++) {
            finishTimeByRank[r] = t;
            const gap = 70 + (r / Math.max(1, n - 1)) * 25 + (Math.random() - 0.5) * 30; // だいたい50〜120ms
            t += Math.max(50, Math.min(120, gap));
        }
        const maxFinishMs = finishTimeByRank[n - 1] ?? (baseMs + 1800);

        // ---- pace curve: 先行/差し ----
        const progressCurve = (u: number, style: number) => {
            const s = clamp11(style);
            const k = 1.25 + 0.55 * Math.abs(s); // 1.25..1.80（極端にしない）
            if (s >= 0) return Math.pow(u, k);                 // 差し：後半寄り
            return 1 - Math.pow(1 - u, k);                     // 先行：前半寄り
        };

        // ---- colors by surface ----
        const trackColor = surface === '芝' ? '#2E7D32' : '#8B4513';
        const infieldColor = surface === '芝' ? '#1B5E20' : '#228B22';

        // ---- init runners ----
        const wakuColors = ['#fff', '#333', '#c9242b', '#1e7eb6', '#d6c526', '#2a9235', '#d4590f', '#d985a8'];

        runnersRef.current = horses.map((h) => {
            const rank = rankByNo.get(h.number);
            const safeRank = (rank != null && rank >= 0 && rank < n) ? rank : (n - 1);
            const finishTimeMs = finishTimeByRank[safeRank] ?? maxFinishMs;

            const styleBase = inferStyleFromLast5(h);
            const style = clamp11(styleBase + (Math.random() - 0.5) * 0.20);

            // 出遅れ/反応差は小さく（下位だけ遅いにならないよう rank と独立）
            const breakDelayMs = Math.max(0, Math.min(140, 40 + (Math.random() - 0.5) * 80));

            return {
                horse: h,
                dist: 0,
                lane: h.gate - 1,
                color: wakuColors[(h.gate - 1) % 8] || '#888',
                finishRank: safeRank,
                finishTimeMs,
                style,
                breakDelayMs,
                phase: Math.random() * Math.PI * 2,
                finished: false
            };
        });

        // ---- main loop ----
        let startTime = performance.now();
        const startDelayMs = 1400;
        let startOverlayActive = true;

        let allFinished = false;
        let lastUiUpdate = 0;
        const uiUpdateIntervalMs = 220;

        const stopAfterMs = startDelayMs + maxFinishMs + 5000;

        const loop = (time: number) => {
            const elapsed = time - startTime;

            if (elapsed > startDelayMs && startOverlayActive) {
                startOverlayActive = false;
                setShowStart(false);
            }

            const raceMs = elapsed - startDelayMs;

            if (raceMs >= 0 && !allFinished) {
                // 共通ペース（隊列が詰まりやすい）
                const commonTimeMs = (baseMs + surfaceAdj + babaAdj) * 1.02;

                runnersRef.current.forEach(r => {
                    if (r.finished) return;

                    const eff = raceMs - r.breakDelayMs;
                    if (eff <= 0) { r.dist = 0; return; }

                    if (eff >= r.finishTimeMs) {
                        r.dist = totalDistance;
                        r.finished = true;
                        return;
                    }

                    const uHorse = clamp01(eff / r.finishTimeMs);
                    const uCommon = clamp01(eff / commonTimeMs);

                    // pack: 序盤はuCommon寄り（詰まる）→中盤以降に脚質/個別タイムが効く
                    const pack = smoothstep(0.08, 0.60, uCommon);
                    const frac = (1 - pack) * uCommon + pack * progressCurve(uHorse, r.style);

                    // 微小揺れ（序盤は少し、後半は弱く）
                    const wobble = (1 - pack) * 0.006 * Math.sin((eff / 240) + r.phase);

                    const targetDist = clamp01(frac + wobble) * totalDistance;
                    r.dist = Math.max(r.dist, targetDist);
                });

                if (time - lastUiUpdate >= uiUpdateIntervalMs) {
                    const live = [...runnersRef.current].slice().sort((a, b) => b.dist - a.dist).map(x => x.horse);
                    setRankings(live);
                    lastUiUpdate = time;
                }

                if (raceMs >= maxFinishMs) {
                    allFinished = true;
                    setRankings([...finishOrderRef.current]); // 最終結果はサンプル着順に固定
                    setRaceEnded(true);
                }
            }

            // canvas sizing
            if (containerRef.current) {
                canvas.width = containerRef.current.clientWidth;
                canvas.height = containerRef.current.clientHeight;
            }
            const W = canvas.width;
            const H = canvas.height;

            // background (weather affects sky)
            const isRainy = weather && (weather.includes('雨') || weather.includes('Rain'));
            const grad = ctx.createLinearGradient(0, 0, 0, H);
            if (isRainy) {
                grad.addColorStop(0, '#1a1a2e');
                grad.addColorStop(0.6, '#2d3436');
                grad.addColorStop(1, '#1e272e');
            } else {
                grad.addColorStop(0, '#0b1020');
                grad.addColorStop(0.6, '#132044');
                grad.addColorStop(1, '#0a1228');
            }
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, W, H);

            // rain effect
            if (isRainy) {
                ctx.strokeStyle = 'rgba(200, 200, 255, 0.3)';
                ctx.lineWidth = 1;
                for (let i = 0; i < 50; i++) {
                    const rx = Math.random() * W;
                    const ry = Math.random() * H;
                    ctx.beginPath();
                    ctx.moveTo(rx, ry);
                    ctx.lineTo(rx - 2, ry + 8);
                    ctx.stroke();
                }
            }

            // ---- draw track ----
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;

            if (isStraight) {
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

                // finish line
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
                // outer
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

                // infield
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

                // finish line at start
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
            }

            // horses depth sort
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

                ctx.fillStyle = 'rgba(0,0,0,0.45)';
                ctx.beginPath();
                ctx.ellipse(p.x, p.y + size / 2, size, size / 3, 0, 0, Math.PI * 2);
                ctx.fill();

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
    }, [horses, finishOrder, courseStr, venue, baba, weather]);

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

            {/* Course info overlay */}
            <div style={{
                position: 'absolute', top: '15px', left: '15px',
                background: 'rgba(0,0,0,0.75)', padding: '8px 12px', borderRadius: '8px',
                color: '#fff', fontSize: '0.85rem'
            }}>
                <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>{venue || '不明'}</div>
                <div>{courseStr}</div>
                <div style={{ color: baba === '不良' || baba === '重' ? '#ff6b6b' : '#8f8' }}>馬場: {baba || '不明'}</div>
                {weather && <div>天候: {weather}</div>}
            </div>

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
