import React, { useMemo } from 'react';
import { curvePoints, effectivePreampDb } from '../audio/eqMath';

const WIDTH = 600;
const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 22, left: 34 };
const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

const fmtFreq = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

// Combined EQ response, 20 Hz - 20 kHz on a log axis, theme colours via CSS variables.
const EqCurve = ({ eq, sampleRate = 48000, selectedBandId = null, onSelectBand }) => {
    const { path, fill, range, markers, preamp, yOf } = useMemo(() => {
        const points = curvePoints(eq, { count: 200, sampleRate });
        const maxAbs = Math.max(6, ...points.map(p => Math.abs(p.db)), ...(eq?.bands || []).map(b => Math.abs(Number(b.gain) || 0)));
        const range = Math.ceil((maxAbs + 2) / 3) * 3;
        const innerW = WIDTH - PAD.left - PAD.right;
        const innerH = HEIGHT - PAD.top - PAD.bottom;
        const xOf = (f) => PAD.left + innerW * Math.log(f / 20) / Math.log(1000);
        const yOf = (db) => PAD.top + innerH * (0.5 - db / (2 * range));
        const zero = yOf(0);
        const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.frequency).toFixed(1)},${yOf(p.db).toFixed(1)}`).join(' ');
        const fill = `${d} L${xOf(20000).toFixed(1)},${zero.toFixed(1)} L${xOf(20).toFixed(1)},${zero.toFixed(1)} Z`;
        const preamp = effectivePreampDb(eq, sampleRate);
        const markers = (eq?.bands || []).map(band => ({
            id: band.id,
            x: xOf(Math.min(20000, Math.max(20, band.frequency))),
            y: yOf((Number(band.gain) || 0) + preamp),
            enabled: band.enabled !== false,
            type: band.type
        }));
        return { path: d, fill, range, markers, preamp, xOf, yOf };
    }, [eq, sampleRate]);

    const innerW = WIDTH - PAD.left - PAD.right;
    const xOf = (f) => PAD.left + innerW * Math.log(f / 20) / Math.log(1000);
    const dbTicks = [];
    for (let db = -range; db <= range; db += range / 2) dbTicks.push(db);

    return (
        <svg className="eq-curve" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="Equaliser response curve">
            {GRID_FREQS.map(f => (
                <g key={f}>
                    <line x1={xOf(f)} x2={xOf(f)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="eq-grid" />
                    <text x={xOf(f)} y={HEIGHT - 6} className="eq-axis" textAnchor="middle">{fmtFreq(f)}</text>
                </g>
            ))}
            {dbTicks.map(db => (
                <g key={db}>
                    <line x1={PAD.left} x2={WIDTH - PAD.right} y1={yOf(db)} y2={yOf(db)} className={db === 0 ? 'eq-grid zero' : 'eq-grid'} />
                    <text x={PAD.left - 6} y={yOf(db) + 3} className="eq-axis" textAnchor="end">{db > 0 ? `+${db}` : db}</text>
                </g>
            ))}
            <path d={fill} className="eq-fill" />
            <path d={path} className="eq-line" />
            {markers.map(m => (
                <circle
                    key={m.id}
                    cx={m.x} cy={m.y} r={m.id === selectedBandId ? 7 : 5}
                    className={`eq-marker ${m.enabled ? '' : 'off'} ${m.id === selectedBandId ? 'selected' : ''}`}
                    onClick={() => onSelectBand && onSelectBand(m.id)}
                >
                    <title>{m.type}</title>
                </circle>
            ))}
            <text x={WIDTH - PAD.right} y={PAD.top + 10} className="eq-axis preamp" textAnchor="end">preamp {preamp.toFixed(1)} dB</text>
        </svg>
    );
};

export default EqCurve;
