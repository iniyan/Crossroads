// Full analysis of one file: sniff the container, decode a few short windows spread across
// the track at the native sample rate (never the whole file, never resampled), measure them
// and produce a verdict. Runs unchanged in the Web Worker (app) and in Node (tests, fixture
// pipeline): the only I/O is `source.read(offset, length)`.

import { readFlacHeader, decodeFrames, estimateByteOffset, canSeek, id3v2Length } from './flacDecoder.js';
import { readWavHeader, readAiffHeader, readPcmWindow } from './pcmDecoders.js';
import { windowSpectrum, powerToDb, meanPower, downsampleToDb, rmsToDb } from './spectrum.js';
import { findShelf, effectiveBandwidth, bandLevelDb, bitDepthStats, mergeBitDepthStats, summarizeBitDepth } from './detectors.js';
import { ANALYZER_VERSION, THRESHOLDS, classifySpectrum, classifyBitDepth, combineVerdict, shelfSearchMaxHz, pickShelf } from './verdict.js';

export const SPECTRUM_POINTS = 256;
export const DEFAULT_WINDOWS = 8;        // hi-res: more windows help the cutoff consistency check
export const DEFAULT_WINDOWS_CD = 5;     // 44.1/48 kHz: a lossy cut shows in a handful of passages
/** Largest single byte-range read for one window (bounds hostile headers and hi-res 8-channel files). */
export const MAX_WINDOW_READ_BYTES = 8 * 1024 * 1024;
const MAX_SAMPLE_RATE = 768000;
const MIN_SAMPLE_RATE = 1000;

export class AnalysisCancelled extends Error {
    constructor() { super('analysis cancelled'); this.name = 'AnalysisCancelled'; }
}

/** How many windows to sample by default at this rate. */
export const defaultWindowCount = (sampleRate) => (sampleRate >= 88200 ? DEFAULT_WINDOWS : DEFAULT_WINDOWS_CD);

/**
 * Spreads `count` windows of `seconds` over the middle 90 % of the track.
 * @returns {Array<{ start: number, length: number }>} in samples
 */
export function planWindows(totalSamples, sampleRate, { count, seconds } = {}) {
    const secs = seconds || (sampleRate >= 88200 ? 3 : 4);
    const windowLen = Math.max(1, Math.round(secs * sampleRate));
    if (!totalSamples || totalSamples <= windowLen) return [{ start: 0, length: totalSamples || windowLen }];
    const lo = Math.floor(totalSamples * 0.05);
    const hi = Math.ceil(totalSamples * 0.95);
    const span = hi - lo;
    let n = count || defaultWindowCount(sampleRate);
    if (span < windowLen * n * 1.2) n = Math.max(1, Math.floor(span / (windowLen * 1.2)));
    if (n <= 1) return [{ start: Math.max(0, Math.floor((totalSamples - windowLen) / 2)), length: windowLen }];
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({ start: lo + Math.floor(i * (span - windowLen) / (n - 1)), length: windowLen });
    }
    return out;
}

function unsupported(reason, extra = {}) {
    return {
        version: ANALYZER_VERSION, analyzedAt: Date.now(), verdict: 'unsupported', confidence: 0, flags: [],
        reason, effectiveBitDepth: null, effectiveBandwidthHz: null, cutoffHz: null, evidence: null, ...extra
    };
}

const startsWith = (b, s, o = 0) => b.length >= o + s.length && s.split('').every((ch, i) => b[o + i] === ch.charCodeAt(0));

/** Which container the bytes belong to: 'FLAC' | 'WAV' | 'AIFF' | null. */
export function sniffContainer(head) {
    const skip = id3v2Length(head);
    if (startsWith(head, 'fLaC', skip)) return 'FLAC';
    if (startsWith(head, 'RIFF') && startsWith(head, 'WAVE', 8)) return 'WAV';
    if (startsWith(head, 'FORM') && (startsWith(head, 'AIFF', 8) || startsWith(head, 'AIFC', 8))) return 'AIFF';
    return null;
}

/**
 * sniffContainer() over a source: when an ID3v2 tag is longer than the head that was read
 * (cover art can make it megabytes), the marker is looked up where the tag ends.
 */
export async function sniffSource(source) {
    const head = await source.read(0, 64);
    const skip = id3v2Length(head);
    if (skip > 0 && skip + 4 > head.length) {
        const marker = await source.read(skip, 4);
        return startsWith(marker, 'fLaC') ? 'FLAC' : null;
    }
    return sniffContainer(head);
}

const knownSize = (source) => (Number.isFinite(source.size) && source.size > 0 ? source.size : null);

async function openFlac(source) {
    const header = await readFlacHeader(source);
    if (!header) return null;
    const { streamInfo } = header;
    if (streamInfo.bitsPerSample > 32 || streamInfo.channels < 1) return null;
    // The size may only be learned by the first read (Content-Range), hence after the header.
    const size = knownSize(source);
    if (!canSeek(header, size)) throw new Error('file size unknown: cannot position within the stream');
    const rawBytesPerSample = streamInfo.channels * streamInfo.bitsPerSample / 8;
    const audioBytes = Math.max(0, (size || 0) - header.audioOffset);
    // Average compressed bytes per sample; a hostile STREAMINFO (totalSamples = 1) cannot
    // inflate it beyond the uncompressed size plus frame overhead.
    let bytesPerSample = streamInfo.totalSamples > 0 && audioBytes > 0
        ? audioBytes / streamInfo.totalSamples
        : rawBytesPerSample * 0.7;
    bytesPerSample = Math.min(bytesPerSample, rawBytesPerSample + streamInfo.channels * 0.125 + 2);
    return {
        kind: 'FLAC', sampleRate: streamInfo.sampleRate, channels: streamInfo.channels,
        containerBits: streamInfo.bitsPerSample, validBits: streamInfo.bitsPerSample, isFloat: false,
        totalSamples: streamInfo.totalSamples, md5: streamInfo.md5,
        async readWindow(start, count) {
            let pos = estimateByteOffset(header, size === null ? Infinity : size, start);
            const need = Math.min(MAX_WINDOW_READ_BYTES, Math.ceil(count * bytesPerSample * 1.25) + 65536);
            const parts = [];
            let got = 0;
            let scanned = 0;
            let firstSample = null;
            let corrected = false;
            for (let iter = 0; iter < 6 && got < count; iter++) {
                const chunk = await source.read(pos, need);
                if (chunk.length === 0) break;
                const res = decodeFrames(chunk, 0, streamInfo, { maxSamples: count - got });
                if (res.samples > 0 && got === 0 && !corrected && header.seekTable.length === 0 &&
                    Math.abs(res.firstSample - start) > count && res.firstSample > 0) {
                    // The average-bitrate estimate landed more than a window away (quiet intros
                    // compress far better than the rest): correct once with the local bitrate.
                    corrected = true;
                    const perSample = res.nextOffset / Math.max(1, res.samples); // bytes/sample around here
                    const next = Math.floor(pos + (start - res.firstSample) * Math.min(perSample, bytesPerSample * 2));
                    if (next >= header.audioOffset && (size === null || next < size)) { pos = next; continue; }
                }
                if (res.samples > 0) {
                    if (firstSample === null) firstSample = res.firstSample;
                    parts.push(res.channels);
                    got += res.samples;
                }
                scanned += chunk.length;
                if (res.nextOffset === 0) {
                    // No complete frame in this chunk: it either holds a single huge frame cut
                    // off at the end (rare) or padding; move on with a small overlap.
                    if (chunk.length < need) break;
                    pos += chunk.length - 32;
                } else {
                    if (chunk.length < need && !res.truncated) break; // end of file
                    pos += res.nextOffset;
                }
                if (scanned > need * 4) break;
            }
            const channels = [];
            for (let c = 0; c < streamInfo.channels; c++) {
                const buf = new Int32Array(got);
                let o = 0;
                for (const p of parts) { buf.set(p[c], o); o += p[c].length; }
                channels.push(buf);
            }
            return { channels, samples: got, firstSample };
        }
    };
}

async function openPcm(source, kind) {
    const fmt = kind === 'WAV' ? await readWavHeader(source) : await readAiffHeader(source);
    if (!fmt || fmt.channels < 1 || fmt.sampleRate <= 0) return null;
    if (![8, 16, 24, 32, 64].includes(fmt.containerBits)) return null;
    const frameBytes = fmt.channels * fmt.containerBits / 8;
    const maxFrames = Math.max(1, Math.floor(MAX_WINDOW_READ_BYTES / frameBytes));
    return {
        ...fmt,
        md5: null,
        async readWindow(start, count) {
            const res = await readPcmWindow(source, fmt, start, Math.min(count, maxFrames));
            return { ...res, firstSample: res.samples > 0 ? Math.min(start, fmt.totalSamples) : null };
        }
    };
}

/**
 * @param {{ size: number|null, read(offset:number, length:number): Promise<Uint8Array> }} source
 * @param {object} [meta]  Song fields when known: { lossless, sampleRate, duration, fileSize }
 * @param {object} [options]
 * @param {(p:{done:number,total:number}) => void} [options.onProgress]
 * @param {() => boolean} [options.shouldCancel]
 * @param {() => Promise<void>} [options.pause]  awaited between windows (throttling)
 * @param {number} [options.windows]
 * @throws when the file could not be read at all (unknown size, no decodable audio): such a
 *         failure must not be cached as a verdict.
 */
export async function analyzeTrack(source, meta = {}, options = {}) {
    const started = Date.now();
    const { onProgress, shouldCancel, pause } = options;
    if (meta.lossless === false) return unsupported('lossy');

    const kind = await sniffSource(source);
    if (!kind) return unsupported('format');
    const decoder = kind === 'FLAC' ? await openFlac(source) : await openPcm(source, kind);
    if (!decoder) return unsupported('format');

    const { sampleRate, channels: nch, containerBits, isFloat } = decoder;
    if (!(sampleRate >= MIN_SAMPLE_RATE && sampleRate <= MAX_SAMPLE_RATE) || nch > 8) return unsupported('format');
    if (kind !== 'FLAC' && !decoder.totalSamples) return unsupported('format'); // empty data chunk
    let totalSamples = decoder.totalSamples;
    if (!totalSamples && meta.duration > 0) totalSamples = Math.floor(meta.duration * sampleRate);
    const scale = isFloat ? 1 : 1 / 2 ** (containerBits - 1);
    const plan = planWindows(totalSamples, sampleRate, { count: options.windows, seconds: options.windowSeconds });
    const searchMaxHz = shelfSearchMaxHz(sampleRate);
    // Sharp step (lossy encoders, steep resamplers); at hi-res rates also a wide step for
    // resamplers with a soft transition band (ffmpeg's default spreads it over ~5 kHz).
    const shelfOf = (db, binHz) => pickShelf([
        findShelf(db, binHz, { minHz: THRESHOLDS.shelfMinHz, maxHz: searchMaxHz, stepWidthHz: THRESHOLDS.shelfStepWidthHz }),
        sampleRate >= 88200
            ? findShelf(db, binHz, { minHz: THRESHOLDS.shelfMinHz, maxHz: searchMaxHz, stepWidthHz: THRESHOLDS.wideStepWidthHz, smoothHz: 300 })
            : null
    ]);

    const windows = [];
    const powerSpectra = [];
    let bitStats = null;
    let binHz = sampleRate / 8192;
    let decodedSamples = 0;

    for (let i = 0; i < plan.length; i++) {
        if (shouldCancel && shouldCancel()) throw new AnalysisCancelled();
        if (i > 0 && pause) await pause();
        const { start, length } = plan[i];
        const { channels, samples, firstSample } = await decoder.readWindow(start, length);
        // Report where the decoded audio really starts (a FLAC seek lands on the nearest frame).
        const actualStart = Number.isFinite(firstSample) ? firstSample : start;
        const info = { startSec: actualStart / sampleRate, samples, rmsDb: null, silent: true, informative: false, shelf: null };
        if (samples > 0 && channels.length === nch) {
            decodedSamples += samples;
            const spec = windowSpectrum(channels, { scale, sampleRate });
            binHz = spec.binHz;
            const db = powerToDb(spec.power);
            info.rmsDb = rmsToDb(spec.rms);
            info.silent = spec.frames === 0 || info.rmsDb < THRESHOLDS.silentRmsDb;
            if (!info.silent) {
                // A cut can only show when there is treble to cut: the 8-14 kHz band must sit
                // well above any plausible floor (16-bit dither is ~ -130 dB per bin here).
                const hf = bandLevelDb(db, binHz, 8000, Math.min(14000, sampleRate / 2 - 500));
                info.hfDb = hf;
                info.informative = Number.isFinite(hf) && hf >= THRESHOLDS.informativeMinDb;
                if (info.informative) info.shelf = shelfOf(db, binHz);
                powerSpectra.push(spec.power);
            }
            if (!isFloat) bitStats = mergeBitDepthStats(bitStats, bitDepthStats(channels, containerBits));
        }
        windows.push(info);
        if (onProgress) onProgress({ done: i + 1, total: plan.length });
    }
    if (decodedSamples === 0) {
        // Nothing could be decoded from any window: a read/seek failure or a damaged file,
        // not a verdict about the audio. Throw so the caller retries instead of caching.
        throw new Error('no audio could be decoded from the sampled passages');
    }

    const informative = windows.filter((w) => w.informative);
    let aggregateShelf = null;
    let bandwidthHz = null;
    let spectrumDb = null;
    if (powerSpectra.length > 0) {
        const agg = meanPower(powerSpectra);
        const aggDb = powerToDb(agg);
        aggregateShelf = shelfOf(aggDb, binHz);
        bandwidthHz = effectiveBandwidth(aggDb, binHz).bandwidthHz;
        spectrumDb = downsampleToDb(agg, SPECTRUM_POINTS).map((v) => Math.round(v * 10) / 10);
    }

    const spectral = classifySpectrum({
        sampleRate, aggregateShelf, windowShelves: informative.map((w) => w.shelf),
        informativeWindows: informative.length, bandwidthHz: bandwidthHz || 0
    });
    const bitSummary = isFloat ? null : summarizeBitDepth(bitStats);
    const bitDepth = classifyBitDepth(bitSummary, isFloat ? null : containerBits, windows.filter((w) => !w.silent).length);
    const combined = combineVerdict(spectral, bitDepth);

    return {
        version: ANALYZER_VERSION,
        analyzedAt: Date.now(),
        elapsedMs: Date.now() - started,
        verdict: combined.verdict,
        confidence: combined.confidence,
        flags: combined.flags,
        reason: spectral.reason,
        container: decoder.kind,
        sampleRate,
        channels: nch,
        bitsPerSample: isFloat ? null : containerBits,
        isFloat,
        md5: decoder.md5 || null,
        effectiveBitDepth: bitDepth.effectiveBits,
        effectiveBandwidthHz: bandwidthHz === null ? null : Math.round(bandwidthHz),
        cutoffHz: spectral.cutoffHz === null ? null : Math.round(spectral.cutoffHz),
        cutoffStepDb: spectral.stepDb === null ? null : Math.round(spectral.stepDb * 10) / 10,
        cutoffConsistency: spectral.consistency,
        windowsAnalyzed: windows.length,
        windowsInformative: informative.length,
        evidence: {
            spectrum: spectrumDb ? { db: spectrumDb, nyquistHz: sampleRate / 2 } : null,
            shelf: aggregateShelf ? {
                cutoffHz: Math.round(aggregateShelf.cutoffHz), stepDb: Math.round(aggregateShelf.stepDb * 10) / 10,
                belowDb: Math.round(aggregateShelf.belowDb), aboveDb: Math.round(aggregateShelf.aboveDb),
                recoveryDb: Math.round(aggregateShelf.recoveryDb * 10) / 10, transitionHz: Math.round(aggregateShelf.transitionHz)
            } : null,
            windows: windows.map((w) => ({
                startSec: Math.round(w.startSec * 100) / 100, rmsDb: w.rmsDb === null ? null : Math.round(w.rmsDb),
                silent: w.silent, informative: w.informative,
                cutoffHz: w.shelf ? Math.round(w.shelf.cutoffHz) : null,
                stepDb: w.shelf ? Math.round(w.shelf.stepDb * 10) / 10 : null
            })),
            bitDepth: bitSummary ? {
                containerBits, effectiveBits: bitSummary.effectiveBits, nonZeroSamples: bitSummary.nonZero,
                lowByteZeroFraction: bitSummary.lowByteZeroFraction === null ? null : Math.round(bitSummary.lowByteZeroFraction * 1000) / 1000,
                trailingZeroHistogram: bitStats ? bitStats.histogram : null
            } : null
        }
    };
}
