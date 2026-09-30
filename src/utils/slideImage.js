// Renders a Wrapped slide to a PNG with the 2D canvas API only (no external libraries).
//
// A slide is plain data, the same object WrappedView displays:
//   { kicker, title, subtitle, big, bigUnit, rows: [{ rank, label, sub, value }],
//     bars: [{ label, value, max }], footer, gradient: [c1, c2] }
// Everything is text and simple shapes, so the export needs no CORS-enabled images.

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1920;

const FONT = '"Inter", -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Greedy word wrap for canvas text; exported for tests. */
export const wrapText = (ctx, text, maxWidth, maxLines = 3) => {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    let truncated = false;
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (!current || ctx.measureText(candidate).width <= maxWidth) { current = candidate; continue; }
        if (lines.length === maxLines - 1) { truncated = true; break; }
        lines.push(current);
        current = word;
    }
    if (current) lines.push(current);
    if (truncated) {
        let last = lines[lines.length - 1];
        while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
        lines[lines.length - 1] = `${last}…`;
    }
    return lines;
};

/** Cuts `text` with an ellipsis so it measures at most `maxWidth` in the current font; exported for tests. */
export const ellipsize = (ctx, text, maxWidth) => {
    let value = String(text || '');
    if (ctx.measureText(value).width <= maxWidth) return value;
    while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) value = value.slice(0, -1);
    return `${value}…`;
};

const roundedRect = (ctx, x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
};

/**
 * Draws `slide` on `ctx` (a CanvasRenderingContext2D-like object) at SLIDE_WIDTH x SLIDE_HEIGHT.
 */
export const drawSlide = (ctx, slide, { width = SLIDE_WIDTH, height = SLIDE_HEIGHT, periodLabel = '', appName = 'Crossroads' } = {}) => {
    const [c1, c2] = slide.gradient || ['#1e1b4b', '#0f172a'];
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, c1);
    gradient.addColorStop(1, c2);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // soft highlight blob
    const glow = ctx.createRadialGradient(width * 0.8, height * 0.15, 0, width * 0.8, height * 0.15, width * 0.7);
    glow.addColorStop(0, 'rgba(255,255,255,0.14)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    const margin = 96;
    const contentWidth = width - margin * 2;
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `700 34px ${FONT}`;
    // Every single-line text is ellipsized to the room it has, so a long title, artist or
    // value can never run into its neighbour or off the canvas.
    const periodText = periodLabel ? ellipsize(ctx, periodLabel, Math.floor(contentWidth * 0.4)) : '';
    const periodWidth = periodText ? ctx.measureText(periodText).width : 0;
    ctx.fillText(ellipsize(ctx, (slide.kicker || '').toUpperCase(), contentWidth - periodWidth - (periodText ? 40 : 0)), margin, 150);
    if (periodText) {
        ctx.textAlign = 'right';
        ctx.fillText(periodText, width - margin, 150);
        ctx.textAlign = 'left';
    }

    let y = 230;
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 96px ${FONT}`;
    wrapText(ctx, slide.title, contentWidth, 3).forEach(line => { ctx.fillText(line, margin, y); y += 108; });

    if (slide.subtitle) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = `500 40px ${FONT}`;
        wrapText(ctx, slide.subtitle, contentWidth, 4).forEach(line => { ctx.fillText(line, margin, y + 10); y += 52; });
        y += 20;
    }

    if (slide.big !== undefined && slide.big !== null) {
        y += 40;
        ctx.fillStyle = '#ffffff';
        ctx.font = `900 220px ${FONT}`;
        const bigText = ellipsize(ctx, String(slide.big), contentWidth);
        ctx.fillText(bigText, margin, y);
        const bigWidth = ctx.measureText(bigText).width;
        if (slide.bigUnit) {
            ctx.font = `600 64px ${FONT}`;
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            const unitMax = contentWidth - bigWidth - 24;
            if (unitMax > 60) ctx.fillText(ellipsize(ctx, slide.bigUnit, unitMax), margin + bigWidth + 24, y + 140);
        }
        y += 270;
    }

    if (Array.isArray(slide.rows) && slide.rows.length > 0) {
        y += 30;
        const rowHeight = 108;
        slide.rows.slice(0, 8).forEach((row, i) => {
            const top = y + i * rowHeight;
            ctx.fillStyle = i === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
            roundedRect(ctx, margin, top, contentWidth, rowHeight - 14, 22);
            ctx.fill();
            // Layout: [28px pad][rank, 72px][label / sub ...][gap 24][value, at most 40%][28px pad]
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.font = `800 40px ${FONT}`;
            ctx.fillText(ellipsize(ctx, String(row.rank ?? i + 1), 64), margin + 28, top + 26);
            ctx.font = `600 32px ${FONT}`;
            const valueText = row.value ? ellipsize(ctx, String(row.value), Math.floor(contentWidth * 0.4)) : '';
            const valueWidth = valueText ? ctx.measureText(valueText).width : 0;
            const labelMax = contentWidth - 100 - 28 - valueWidth - (valueText ? 24 : 0);
            ctx.fillStyle = '#ffffff';
            ctx.font = `700 40px ${FONT}`;
            ctx.fillText(ellipsize(ctx, row.label, labelMax), margin + 100, row.sub ? top + 14 : top + 26);
            if (row.sub) {
                ctx.fillStyle = 'rgba(255,255,255,0.65)';
                ctx.font = `500 28px ${FONT}`;
                ctx.fillText(ellipsize(ctx, row.sub, labelMax), margin + 100, top + 58);
            }
            if (valueText) {
                ctx.fillStyle = 'rgba(255,255,255,0.85)';
                ctx.font = `600 32px ${FONT}`;
                ctx.textAlign = 'right';
                ctx.fillText(valueText, margin + contentWidth - 28, top + 30);
                ctx.textAlign = 'left';
            }
        });
        y += Math.min(slide.rows.length, 8) * rowHeight;
    }

    if (Array.isArray(slide.bars) && slide.bars.length > 0) {
        y += 40;
        const max = Math.max(1, ...slide.bars.map(b => b.value || 0), ...slide.bars.map(b => b.max || 0));
        const barHeight = 64;
        const gap = 26;
        // Layout: [label, 320px][gap 20][bar][gap 20][value, right-aligned in 120px]
        slide.bars.slice(0, 7).forEach((bar, i) => {
            const top = y + i * (barHeight + gap);
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.font = `600 32px ${FONT}`;
            ctx.fillText(ellipsize(ctx, bar.label, 320), margin, top + 14);
            const barX = margin + 340;
            const barW = contentWidth - 340 - 140;
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            roundedRect(ctx, barX, top, barW, barHeight, 16);
            ctx.fill();
            const w = Math.max(barHeight, barW * ((bar.value || 0) / max));
            ctx.fillStyle = bar.color || '#ffffff';
            roundedRect(ctx, barX, top, w, barHeight, 16);
            ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.textAlign = 'right';
            ctx.fillText(ellipsize(ctx, bar.valueLabel || String(bar.value), 120), margin + contentWidth, top + 14);
            ctx.textAlign = 'left';
        });
    }

    // footer
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `500 30px ${FONT}`;
    if (slide.footer) ctx.fillText(ellipsize(ctx, slide.footer, contentWidth), margin, height - 200);
    ctx.font = `800 34px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(`${appName} Wrapped`, margin, height - 130);
};

/** Renders the slide and resolves a PNG Blob (browser only). */
export const slideToPngBlob = (slide, options = {}) => new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = options.width || SLIDE_WIDTH;
    canvas.height = options.height || SLIDE_HEIGHT;
    const ctx = canvas.getContext('2d');
    try {
        drawSlide(ctx, slide, { ...options, width: canvas.width, height: canvas.height });
    } catch (e) {
        reject(e);
        return;
    }
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Could not encode PNG'))), 'image/png');
});

/** Blob -> base64 (without the data: prefix). */
export const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
});
