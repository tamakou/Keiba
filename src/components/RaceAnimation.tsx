'use client';
import { useEffect, useRef, useState } from 'react';
import { Horse } from '@/lib/types';

interface RaceAnimationProps {
    horses: Horse[];
    winner: Horse;
    onFinish: () => void;
}

interface Runner {
    horse: Horse;
    position: number; // 0 to TrackLength
    speed: number;
    lane: number;
    rank: number; // Current rank
}

const TRACK_LENGTH = 5000; // Virtual meters/pixels
const DURATION_MS = 15000; // 15 seconds race
const FPS = 60;

export default function RaceAnimation({ horses, winner, onFinish }: RaceAnimationProps) {
    const requestRef = useRef<number | null>(null);
    const [runners, setRunners] = useState<Runner[]>([]);
    const [cameraX, setCameraX] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);

    // Initialize runners
    useEffect(() => {
        const initialRunners = horses.map((h, i) => ({
            horse: h,
            position: 0,
            speed: 0,
            lane: i,
            rank: 1
        }));
        setRunners(initialRunners);

        // Start Loop
        let startTime = performance.now();

        const animate = (time: number) => {
            const elapsed = time - startTime;
            const progress = Math.min(elapsed / DURATION_MS, 1.0);

            setRunners(prev => {
                const nextRunners = prev.map(r => {
                    // Base target distance is full track
                    // Randomness: smooth noise would be better, but random walk works

                    // Determine goal factor: 
                    // Winner gets 1.05 boost, others 0.95-1.0 random
                    const isWinner = r.horse.number === winner.number;
                    const baseSpeed = (TRACK_LENGTH / (DURATION_MS / 1000 * FPS)); // Pixels per frame

                    // Speed variation
                    let variation = (Math.random() - 0.5) * 5;

                    // Rubber banding / Scripting
                    // If winner is behind near end, boost significantly
                    // If loser is ahead near end, slow down

                    if (progress > 0.8) {
                        // "Final Spurt"
                        if (isWinner) {
                            variation += 5;
                        } else {
                            variation -= 2;
                        }
                    }

                    // Apply speed
                    let newSpeed = baseSpeed + variation;
                    if (newSpeed < 0) newSpeed = 0;

                    let newPos = r.position + newSpeed;

                    // Clamp logic to ensure winner wins exactly at end?
                    // Simpler: Just rely on slight speed bias and hard clamp at finish?
                    // Or let physics run.

                    // Better approach for determinism:
                    // Interpolate between Start(0) and Finish(Length)
                    // Add sine wave noise for "overtaking"

                    // Deterministic Curve
                    // Winner: Linear + Boost at end
                    // Others: Linear + Fall off at end

                    const p = progress;

                    // Normalized curve (0 to 1)
                    let curve = p;
                    // Add random wobble
                    // Unique offset per horse
                    const seed = r.lane * 100;
                    const wobble = Math.sin(p * 20 + seed) * (0.02 * (1 - p)); // Wobble reduces near end

                    // Finishing Order Logic
                    // We only know the Winner.
                    // For others, use their estimatedProb as "strength"
                    // Higher prob -> closesr to winner
                    const strength = r.horse.estimatedProb * 5; // boosting the signal
                    // Winner strength is max
                    const finalFactor = isWinner ? 1.0 : (0.90 + (Math.min(strength, 0.09)));

                    // Position = Length * (progress * finalFactor + wobble)
                    // But we want everyone to be close.

                    // Re-calculate strictly based on progress to guarantee finish order implies winner first?
                    // "Real" physics is better visually.

                    return {
                        ...r,
                        position: newPos,
                        speed: newSpeed
                    };
                });

                // Calculate View Camera (Follow Leader)
                const leader = nextRunners.reduce((prev, current) => (prev.position > current.position) ? prev : current);
                return nextRunners;
            });

            if (progress < 1) {
                requestRef.current = requestAnimationFrame(animate);
            } else {
                onFinish();
            }
        };

        requestRef.current = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(requestRef.current!);
    }, [horses, winner, onFinish]);

    // Update camera separately or inside loop? 
    // Effect dependent on runners state
    useEffect(() => {
        if (runners.length === 0) return;
        const leader = runners.reduce((prev, current) => (prev.position > current.position) ? prev : current);
        // Center leader
        // Canvas width approx 1000? 
        // CameraX = leader.pos - 500
        setCameraX(Math.max(0, leader.position - 400));
    }, [runners]);

    return (
        <div className="race-track-container" ref={containerRef} style={{
            width: '100%',
            height: '400px',
            background: 'linear-gradient(to bottom, #87CEEB 0%, #87CEEB 40%, #228B22 40%, #228B22 100%)', // Sky and Turf
            position: 'relative',
            overflow: 'hidden',
            borderRadius: '10px',
            boxShadow: 'inset 0 0 20px rgba(0,0,0,0.5)'
        }}>
            {/* Background elements (Fences, markers) could move parallax */}
            <div style={{
                position: 'absolute',
                left: -(cameraX * 0.5) % 1000,
                top: '40%',
                width: '10000px',
                height: '5px',
                background: '#fff', // Fence rail
                zIndex: 5
            }} />
            <div style={{
                position: 'absolute',
                left: -(cameraX) + TRACK_LENGTH,
                top: '0',
                height: '100%',
                width: '10px',
                background: 'repeating-linear-gradient(45deg, yellow, yellow 10px, black 10px, black 20px)',
                zIndex: 1,
                opacity: 0.8
            }} /> {/* Finish Line */}

            {runners.map((r, i) => (
                <div key={`${r.horse.number}-${i}`} style={{
                    position: 'absolute',
                    left: (r.position - cameraX),
                    top: `${45 + (r.lane * (50 / runners.length))}%`, // Spread vertical
                    transition: 'left 0.1s linear', // Smooth out react updates
                    zIndex: Math.floor(r.lane + 10),
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center'
                }}>
                    {/* Horse Graphic */}
                    <div className="horse-sprite" style={{
                        fontSize: '2rem',
                        transform: `scaleX(-1) translateY(${Math.sin(r.position / 20) * 5}px) rotate(${Math.sin(r.position / 10) * 5}deg)`, // Gallop animation
                        textShadow: '2px 2px 5px rgba(0,0,0,0.5)'
                    }}>
                        🐎
                    </div>
                    <div style={{
                        background: r.horse.number === winner.number ? '#efbf04' : 'rgba(0,0,0,0.7)',
                        color: '#fff',
                        padding: '2px 5px',
                        borderRadius: '4px',
                        fontSize: '0.7rem',
                        marginTop: '-5px'
                    }}>
                        {r.horse.number}
                    </div>
                    <div style={{ fontSize: '0.6rem', color: '#fff', textShadow: '1px 1px 2px #000' }}>
                        {r.horse.name}
                    </div>
                </div>
            ))}

            {/* Dust Particles? */}
        </div>
    );
}
