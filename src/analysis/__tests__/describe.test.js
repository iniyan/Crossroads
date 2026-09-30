import { describe, it, expect } from 'vitest';
import { describeResult, badgeLabel, confidenceLabel, verdictTone, VERDICT_TITLES } from '../describe.js';

const base = { sampleRate: 44100, bitsPerSample: 24, effectiveBitDepth: 24, effectiveBandwidthHz: 16900, windowsAnalyzed: 8, windowsInformative: 8, cutoffConsistency: 1, flags: [], evidence: { bitDepth: { lowByteZeroFraction: 0.004 } } };

describe('describeResult', () => {
    it('never accuses without "Likely", explains the measurement and names the innocent explanation', () => {
        const r = describeResult({ ...base, verdict: 'lossy-transcode', confidence: 0.85, cutoffHz: 16796, cutoffStepDb: 47.8, flags: ['lossy-transcode'] });
        expect(r.title).toBe('Likely lossy transcode');
        expect(r.summary).toContain('16.8 kHz');
        expect(r.summary).toContain('48 dB');
        expect(r.summary).toContain('A deliberate low-pass (lo-fi / sound design) can look the same');
        expect(r.details.some((d) => d.includes('8 of 8'))).toBe(true);
        expect(r.suspicious).toBe(true);
        expect(r.tone).toBe('warn');
    });
    it('upsampled copy names the likely source rate, the 320 kbps caveat and the hi-res master caveat', () => {
        const r = describeResult({ ...base, sampleRate: 96000, verdict: 'upsampled', confidence: 0.85, cutoffHz: 20367, flags: ['upsampled'] });
        expect(r.summary).toContain('44.1 kHz source');
        expect(r.details.some((d) => d.includes('320 kbps'))).toBe(true);
        expect(r.details.some((d) => d.includes('brickwall low-pass at or below 22 kHz would look the same'))).toBe(true);
        expect(describeResult({ ...base, sampleRate: 96000, verdict: 'upsampled', cutoffHz: 22400, flags: ['upsampled'] }).summary).toContain('44.1 kHz source');
    });
    it('band-limited copy is neutral and rate-aware', () => {
        const cd = describeResult({ ...base, verdict: 'band-limited', confidence: 0.6, cutoffHz: 20026, cutoffStepDb: 64.2 });
        expect(cd.title).toBe('Band-limited');
        expect(cd.summary).toBe('Band-limited: sharp low-pass at 20.0 kHz — could be a mastering filter or a high-bitrate lossy source.');
        expect(cd.suspicious).toBe(false);
        expect(cd.tone).toBe('neutral');
        expect(cd.details.some((d) => d.includes('64 dB'))).toBe(true);
        expect(cd.details.some((d) => d.includes('Not counted as suspicious'))).toBe(true);
        const hires = describeResult({ ...base, sampleRate: 96000, verdict: 'band-limited', confidence: 0.6, cutoffHz: 24129, cutoffStepDb: 106 });
        expect(hires.summary).toContain('24.1 kHz');
        expect(hires.summary).toMatch(/DSD\/SACD conversion/);
        expect(hires.summary).toMatch(/lower-rate source resampled with a soft filter/);
    });
    it('padded copy states the bit counts and additional flags are listed', () => {
        const r = describeResult({ ...base, verdict: 'lossy-transcode', cutoffHz: 16000, effectiveBitDepth: 16, flags: ['lossy-transcode', 'padded'] });
        expect(r.details.some((d) => d.includes('Also: padded bit depth'))).toBe(true);
        const p = describeResult({ ...base, verdict: 'padded', effectiveBitDepth: 16, flags: ['padded'] });
        expect(p.summary).toContain('top 16 bits');
        expect(p.summary).toContain('low 8 bits');
    });
    it('genuine, inconclusive and unsupported copy', () => {
        expect(describeResult({ ...base, verdict: 'genuine', confidence: 0.9 })).toMatchObject({ suspicious: false, tone: 'ok' });
        expect(describeResult({ ...base, verdict: 'genuine', reason: 'cut-at-nyquist', cutoffHz: 22400, sampleRate: 48000 }).summary).toContain('22.4 kHz');
        expect(describeResult({ ...base, verdict: 'inconclusive', reason: 'too-quiet' }).summary)
            .toBe('Not enough high-frequency content to judge (quiet passages or a naturally dull recording).');
        expect(describeResult({ ...base, verdict: 'inconclusive', reason: 'too-quiet' }).tone).toBe('muted');
        expect(describeResult({ ...base, verdict: 'unsupported', reason: 'lossy' }).summary).toMatch(/lossy file/);
        expect(describeResult(null).title).toBe('Not analysed yet');
        expect(Object.keys(VERDICT_TITLES)).toHaveLength(7);
    });
    it('badge, tone and confidence labels', () => {
        expect(badgeLabel({ verdict: 'lossy-transcode' })).toBe('Transcode?');
        expect(badgeLabel({ verdict: 'upsampled' })).toBe('Upsampled?');
        expect(badgeLabel({ verdict: 'padded' })).toBe('Padded?');
        expect(badgeLabel({ verdict: 'band-limited' })).toBe('Band-limited');
        expect(badgeLabel({ verdict: 'genuine' })).toBeNull();
        expect(badgeLabel(null)).toBeNull();
        expect(verdictTone({ verdict: 'band-limited' })).toBe('neutral');
        expect(verdictTone({ verdict: 'padded' })).toBe('warn');
        expect(verdictTone(null)).toBe('muted');
        expect(confidenceLabel(0.95)).toBe('high confidence');
        expect(confidenceLabel(0.65)).toBe('medium confidence');
        expect(confidenceLabel(0.4)).toBe('low confidence');
        expect(confidenceLabel(0)).toBe('');
    });
});
