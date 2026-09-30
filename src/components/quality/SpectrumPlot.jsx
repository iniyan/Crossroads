import React, { useEffect, useRef } from 'react';

const HEIGHT = 220;
const PAD = { left: 40, right: 12, top: 12, bottom: 24 };
const DB_MIN = -160;
const DB_MAX = 0;

const cssVar = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
};

function draw(canvas, { spectrum, cutoffHz, sampleRate, cutoffColorVar }) {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);

    const text = cssVar('--text-primary', '#f8fafc');
    const muted = cssVar('--text-secondary', '#94a3b8');
    const accent = cssVar('--accent-monitor', '#22d3ee');
    const warn = cssVar(cutoffColorVar || '--q-warn', '#f59e0b');
    const nyquist = spectrum.nyquistHz || sampleRate / 2;
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (hz) => PAD.left + (hz / nyquist) * plotW;
    const y = (db) => PAD.top + (1 - (Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * plotH;

    ctx.font = '10px ' + cssVar('--font-family', 'sans-serif');
    ctx.lineWidth = 1;

    // Grid: dB lines and kHz ticks
    ctx.strokeStyle = muted;
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = muted;
    for (let db = DB_MAX; db >= DB_MIN; db -= 40) {
        ctx.beginPath(); ctx.moveTo(PAD.left, y(db)); ctx.lineTo(width - PAD.right, y(db)); ctx.stroke();
    }
    const tickHz = nyquist > 30000 ? 10000 : 5000;
    for (let hz = 0; hz <= nyquist; hz += tickHz) {
        ctx.beginPath(); ctx.moveTo(x(hz), PAD.top); ctx.lineTo(x(hz), HEIGHT - PAD.bottom); ctx.stroke();
    }
    ctx.globalAlpha = 0.9;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let db = DB_MAX; db >= DB_MIN; db -= 40) ctx.fillText(`${db}`, PAD.left - 6, y(db));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let hz = 0; hz <= nyquist; hz += tickHz) ctx.fillText(`${hz / 1000}k`, x(hz), HEIGHT - PAD.bottom + 6);

    // Spectrum: filled area + line
    const db = spectrum.db;
    const n = db.length;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(x(0), y(DB_MIN));
    for (let i = 0; i < n; i++) ctx.lineTo(x((i + 0.5) / n * nyquist), y(db[i]));
    ctx.lineTo(x(nyquist), y(DB_MIN));
    ctx.closePath();
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.18;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
        const px = x((i + 0.5) / n * nyquist);
        const py = y(db[i]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Markers: the CD-rate limit for hi-res files, the detected cutoff, Nyquist
    ctx.lineWidth = 1;
    ctx.textBaseline = 'top';
    if (nyquist > 22050 * 1.2) {
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = muted;
        ctx.globalAlpha = 0.7;
        ctx.beginPath(); ctx.moveTo(x(22050), PAD.top); ctx.lineTo(x(22050), HEIGHT - PAD.bottom); ctx.stroke();
        ctx.fillStyle = muted;
        ctx.textAlign = 'left';
        ctx.fillText('CD limit 22.05k', x(22050) + 4, PAD.top + 14);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
    }
    if (Number.isFinite(cutoffHz) && cutoffHz > 0) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = warn;
        ctx.beginPath(); ctx.moveTo(x(cutoffHz), PAD.top); ctx.lineTo(x(cutoffHz), HEIGHT - PAD.bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = warn;
        ctx.textAlign = x(cutoffHz) > width * 0.75 ? 'right' : 'left';
        ctx.fillText(`cut ${(cutoffHz / 1000).toFixed(1)} kHz`, x(cutoffHz) + (ctx.textAlign === 'left' ? 4 : -4), PAD.top);
    }
    ctx.fillStyle = text;
    ctx.textAlign = 'right';
    ctx.fillText(`Nyquist ${(nyquist / 1000).toFixed(2)} kHz`, width - PAD.right, PAD.top);
    ctx.textAlign = 'left';
    ctx.fillStyle = muted;
    ctx.fillText('dB', PAD.left + 4, PAD.top);
}

/**
 * Averaged spectrum of the analysed passages on a canvas, with the detected cutoff and the
 * Nyquist frequency marked. Follows the theme (redraws when data-theme changes).
 */
export default function SpectrumPlot({ spectrum, cutoffHz, sampleRate, suspicious }) {
    const ref = useRef(null);

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas || !spectrum || !spectrum.db) return undefined;
        const render = () => draw(canvas, { spectrum, cutoffHz, sampleRate, cutoffColorVar: suspicious ? '--q-warn' : '--text-secondary' });
        render();
        const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(render) : null;
        if (resize) resize.observe(canvas);
        const themeObserver = typeof MutationObserver === 'function' ? new MutationObserver(render) : null;
        if (themeObserver) themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => {
            if (resize) resize.disconnect();
            if (themeObserver) themeObserver.disconnect();
        };
    }, [spectrum, cutoffHz, sampleRate, suspicious]);

    if (!spectrum || !spectrum.db) return null;
    return <canvas ref={ref} className="q-spectrum" style={{ width: '100%', height: HEIGHT }} />;
}
