// Audio quality classification: tier (Hi-Res / CD / lossy) and the badge label.

const HIRES_MIN_BITS = 24;
const HIRES_MIN_RATE = 88200;

const LOSSLESS_FORMATS = new Set(['FLAC', 'WAV', 'AIFF', 'ALAC', 'APE', 'WV', 'TTA', 'DSF', 'DFF']);
const LOSSY_FORMATS = new Set(['MP3', 'AAC', 'OGG', 'VORBIS', 'OPUS', 'WMA', 'MP2', 'AC3']);

const toNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/** 44100 -> '44.1', 48000 -> '48', 96000 -> '96', 176400 -> '176.4', 2822400 -> '2822.4'. */
export const formatSampleRateKHz = (sampleRate) => {
    const hz = toNumber(sampleRate);
    if (hz === null) return null;
    const khz = hz / 1000;
    const rounded = Math.round(khz * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

/**
 * Resolves the format shown in badges from the container and codec, so an M4A carrying
 * ALAC reads 'ALAC' and one carrying AAC reads 'AAC'.
 */
export const resolveFormat = (format, codec) => {
    const fmt = String(format || '').toUpperCase();
    const cdc = String(codec || '').toUpperCase();
    if (fmt === 'M4A' || fmt === 'MP4' || fmt === 'M4B') {
        if (cdc.includes('ALAC')) return 'ALAC';
        if (cdc.includes('AAC') || cdc.includes('MP4A')) return 'AAC';
        return fmt;
    }
    if (fmt === 'OGG') {
        if (cdc.includes('OPUS')) return 'OPUS';
        return fmt;
    }
    if (!fmt || fmt === 'UNKNOWN') {
        if (cdc.includes('FLAC')) return 'FLAC';
        if (cdc.includes('ALAC')) return 'ALAC';
        if (cdc.includes('AAC')) return 'AAC';
        if (cdc.includes('OPUS')) return 'OPUS';
        if (cdc.includes('VORBIS')) return 'OGG';
        if (cdc.includes('LAYER 3') || cdc.includes('MP3')) return 'MP3';
        return fmt || 'UNKNOWN';
    }
    return fmt;
};

/**
 * true / false / null (unknown). Uses the platform's answer when it gave one, otherwise the
 * codec, otherwise the format table.
 */
export const resolveLossless = (lossless, format, codec) => {
    if (lossless === true || lossless === false) return lossless;
    const cdc = String(codec || '').toUpperCase();
    if (cdc) {
        if (cdc.includes('FLAC') || cdc.includes('ALAC') || cdc.includes('PCM') || cdc.includes('LPCM')) return true;
        if (cdc.includes('AAC') || cdc.includes('MP4A') || cdc.includes('LAYER') || cdc.includes('VORBIS')
            || cdc.includes('OPUS') || cdc.includes('WMA')) return false;
    }
    const fmt = String(format || '').toUpperCase();
    if (LOSSLESS_FORMATS.has(fmt)) return true;
    if (LOSSY_FORMATS.has(fmt)) return false;
    return null;
};

/**
 * Tier rules (#18): lossless and (>=24-bit or >=88.2 kHz) -> 'hires'; other lossless with at
 * least one known property -> 'cd'; lossy -> 'lossy'; anything else -> 'unknown'.
 */
export const qualityTier = ({ lossless, bitsPerSample, sampleRate }) => {
    const bits = toNumber(bitsPerSample);
    const rate = toNumber(sampleRate);
    if (lossless === true) {
        if ((bits !== null && bits >= HIRES_MIN_BITS) || (rate !== null && rate >= HIRES_MIN_RATE)) return 'hires';
        if (bits !== null || rate !== null) return 'cd';
        return 'unknown';
    }
    if (lossless === false) return 'lossy';
    return 'unknown';
};

/** 'FLAC 24/96', 'ALAC 16/44.1', 'WAV 24/192', 'MP3 320', 'AAC 256'; bare format when no data. */
export const qualityLabel = ({ format, lossless, bitsPerSample, sampleRate, bitrate }) => {
    const name = String(format || 'UNKNOWN').toUpperCase();
    if (lossless === true) {
        const bits = toNumber(bitsPerSample);
        const khz = formatSampleRateKHz(sampleRate);
        if (bits !== null && khz !== null) return `${name} ${bits}/${khz}`;
        if (khz !== null) return `${name} ${khz}`;
        if (bits !== null) return `${name} ${bits}-bit`;
        return name;
    }
    if (lossless === false) {
        const bps = toNumber(bitrate);
        if (bps !== null) return `${name} ${Math.round(bps / 1000)}`;
        return name;
    }
    return name;
};

/** @returns {{ tier: import('./song').QualityTier, label: string }} */
export const deriveQuality = (song) => ({
    tier: qualityTier(song),
    label: qualityLabel(song)
});
