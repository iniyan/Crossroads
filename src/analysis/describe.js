// Human copy for analysis results. Honest by design: every accusation is "Likely ...", the
// reasons spell out what was measured, and each accusing verdict names the innocent
// explanation that would look the same.

import { isSuspicious } from './verdict.js';

const khz = (hz) => (hz === null || hz === undefined ? '?' : `${(hz / 1000).toFixed(1)} kHz`);

export const VERDICT_TITLES = Object.freeze({
    'genuine': 'No signs of faking',
    'upsampled': 'Likely upsampled',
    'padded': 'Likely padded bit depth',
    'lossy-transcode': 'Likely lossy transcode',
    'band-limited': 'Band-limited',
    'inconclusive': 'Inconclusive',
    'unsupported': 'Not analysed'
});

/** Short badge text; null when nothing should be shown. */
export function badgeLabel(result) {
    if (!result) return null;
    switch (result.verdict) {
        case 'lossy-transcode': return 'Transcode?';
        case 'upsampled': return 'Upsampled?';
        case 'padded': return 'Padded?';
        case 'band-limited': return 'Band-limited';
        default: return null;
    }
}

/** 'warn' for accusations, 'ok' for genuine, 'neutral' for band-limited, 'muted' otherwise. */
export function verdictTone(result) {
    if (!result) return 'muted';
    if (isSuspicious(result.verdict)) return 'warn';
    if (result.verdict === 'genuine') return 'ok';
    if (result.verdict === 'band-limited') return 'neutral';
    return 'muted';
}

const sourceHint = (cutoffHz) => {
    if (cutoffHz === null || cutoffHz === undefined) return 'a lower-rate source';
    if (cutoffHz <= 22600) return 'a 44.1 kHz source';
    if (cutoffHz <= 27000) return 'a 44.1 or 48 kHz source';
    return 'a lower-rate source';
};

const REASONS = {
    'too-quiet': 'Not enough high-frequency content to judge (quiet passages or a naturally dull recording).',
    'no-hf-content': 'No content above ~27 kHz, but no sharp cut either: band-limited material or a gentle roll-off.',
    'inconsistent-cutoff': 'A sharp cut was found in some passages but not at the same frequency in others.',
    'weak-shelf': 'A cut was found, but it is not deep or consistent enough to call.',
    'cut-near-nyquist': 'The spectrum ends sharply just below Nyquist: that may be a high-bitrate lossy source or a mastering low-pass filter.',
    'hf-cut': 'The spectrum ends sharply well above 27 kHz: an intentional low-pass or a higher-rate source; not judged.',
    'lossy': 'This is a lossy file; only lossless files are analysed.',
    'format': 'Only FLAC, WAV and AIFF can be decoded for analysis.',
    'codec': 'This codec cannot be decoded for analysis (FLAC, WAV and AIFF are supported).',
    'provisional': 'The file has not been indexed yet.'
};

/**
 * @returns {{ title: string, summary: string, details: string[], suspicious: boolean, tone: string }}
 */
export function describeResult(result) {
    if (!result) return { title: 'Not analysed yet', summary: '', details: [], suspicious: false, tone: 'muted' };
    const details = [];
    const title = VERDICT_TITLES[result.verdict] || result.verdict;
    let summary = '';
    const ev = result.evidence || {};
    const bits = result.bitsPerSample;
    const effBits = result.effectiveBitDepth;
    const consistency = result.cutoffConsistency;
    const hires = result.sampleRate >= 88200;
    const windowsNote = Number.isFinite(consistency) && result.windowsInformative
        ? `${Math.round(consistency * result.windowsInformative)} of ${result.windowsInformative} sampled passages agree`
        : null;

    switch (result.verdict) {
        case 'lossy-transcode':
            summary = `The spectrum drops sharply at ${khz(result.cutoffHz)} (by ${Math.round(result.cutoffStepDb || 0)} dB) with nothing above it: the signature of MP3/AAC/Vorbis material re-encoded as lossless. A deliberate low-pass (lo-fi / sound design) can look the same.`;
            if (windowsNote) details.push(`${windowsNote} on the cutoff.`);
            if (hires) details.push(`At ${khz(result.sampleRate)} this cut also means the file was upsampled.`);
            break;
        case 'upsampled':
            summary = `No content above ${khz(result.cutoffHz)}: the spectrum ends with a steep cut where ${sourceHint(result.cutoffHz)} would end. The ${khz(result.sampleRate)} container adds no detail.`;
            if (result.cutoffHz !== null && result.cutoffHz <= 20700) details.push('A cut this low could also come from a 320 kbps MP3 source.');
            details.push('A hi-res master with a brickwall low-pass at or below 22 kHz would look the same.');
            if (windowsNote) details.push(`${windowsNote} on the cutoff.`);
            break;
        case 'band-limited':
            summary = hires
                ? `Band-limited: sharp low-pass at ${khz(result.cutoffHz)} — could be a mastering filter or a DSD/SACD conversion; a lower-rate source resampled with a soft filter can look the same.`
                : `Band-limited: sharp low-pass at ${khz(result.cutoffHz)} — could be a mastering filter or a high-bitrate lossy source.`;
            details.push(`The level drops by ${Math.round(result.cutoffStepDb || 0)} dB at the cut${windowsNote ? `; ${windowsNote}` : ''}.`);
            details.push('Not counted as suspicious: no lossless test can tell these apart.');
            break;
        case 'padded':
            summary = `Only the top ${effBits} bits of each ${bits}-bit sample carry audio; the low ${bits - effBits} bits are always zero. This is ${effBits}-bit audio in a ${bits}-bit container.`;
            break;
        case 'genuine':
            summary = result.reason === 'cut-at-nyquist'
                ? `The spectrum extends to ${khz(result.cutoffHz)}, right below Nyquist, which is what a sample-rate converter or ADC leaves; no lossy-codec cutoff and no padding found.`
                : 'No sharp high-frequency cutoff, no upsampling signature and no padded bits found in the sampled passages.';
            break;
        case 'inconclusive':
            summary = REASONS[result.reason] || 'The sampled passages do not allow a verdict.';
            if (result.cutoffHz !== null && result.cutoffHz !== undefined) details.push(`Sharpest cut: ${khz(result.cutoffHz)} (${Math.round(result.cutoffStepDb || 0)} dB).`);
            break;
        case 'unsupported':
            summary = REASONS[result.reason] || 'This file cannot be analysed.';
            break;
        default:
            summary = '';
    }

    if (result.flags && result.flags.length > 1) {
        const extra = result.flags.filter((f) => f !== result.verdict).map((f) => VERDICT_TITLES[f].replace('Likely ', ''));
        details.push(`Also: ${extra.join(', ')}.`);
    }
    if (result.verdict !== 'unsupported') {
        if (effBits !== null && effBits !== undefined && bits) {
            details.push(`Effective bit depth: ${effBits} of ${bits} bits${ev.bitDepth && ev.bitDepth.lowByteZeroFraction !== null && ev.bitDepth.lowByteZeroFraction !== undefined ? ` (low byte zero in ${Math.round(ev.bitDepth.lowByteZeroFraction * 100)} % of samples)` : ''}.`);
        }
        if (result.effectiveBandwidthHz) details.push(`Content extends to about ${khz(result.effectiveBandwidthHz)} (Nyquist ${khz(result.sampleRate / 2)}).`);
        if (result.windowsAnalyzed) details.push(`${result.windowsAnalyzed} passages sampled${result.windowsInformative !== undefined ? `, ${result.windowsInformative} with enough treble to judge` : ''}.`);
    }
    return { title, summary, details, suspicious: isSuspicious(result.verdict), tone: verdictTone(result) };
}

export const confidenceLabel = (confidence) => {
    if (!Number.isFinite(confidence) || confidence <= 0) return '';
    if (confidence >= 0.85) return 'high confidence';
    if (confidence >= 0.6) return 'medium confidence';
    return 'low confidence';
};
