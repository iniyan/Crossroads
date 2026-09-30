import { describe, expect, it } from 'vitest';
import { activeLineIndex, formatLrcTime, isSyncedLrc, parseLrc, plainText, serializeLrc, META_KEYS } from '../lrc.js';

describe('parseLrc', () => {
    it('parses timestamps with centisecond and millisecond precision', () => {
        const lrc = parseLrc('[00:12.00]First\n[01:03.5]Second\n[02:00.123]Third\n[03:04]Fourth');
        expect(lrc.synced).toBe(true);
        expect(lrc.lines).toEqual([
            { time: 12, text: 'First' },
            { time: 63.5, text: 'Second' },
            { time: 120.123, text: 'Third' },
            { time: 184, text: 'Fourth' }
        ]);
    });

    it('expands several timestamps on one line and sorts by time', () => {
        const lrc = parseLrc('[00:30.00][00:10.00]Chorus\n[00:20.00]Verse');
        expect(lrc.lines).toEqual([
            { time: 10, text: 'Chorus' },
            { time: 20, text: 'Verse' },
            { time: 30, text: 'Chorus' }
        ]);
    });

    it('applies the offset tag (positive = earlier) and never goes below zero', () => {
        const lrc = parseLrc('[offset:+500]\n[00:01.00]A\n[00:00.20]B');
        expect(lrc.offset).toBe(500);
        expect(lrc.lines).toEqual([{ time: 0, text: 'B' }, { time: 0.5, text: 'A' }]);
        expect(parseLrc('[offset:-250]\n[00:01.00]A').lines[0].time).toBe(1.25);
    });

    it('collects metadata tags and ignores enhanced word tags', () => {
        const lrc = parseLrc('[ti:Song]\n[ar: Artist ]\n[al:Album]\n[by:me]\n[00:01.00]<00:01.00>Hello <00:01.50>world');
        expect(lrc.meta).toEqual({ ti: 'Song', ar: 'Artist', al: 'Album', by: 'me' });
        expect(lrc.lines).toEqual([{ time: 1, text: 'Hello world' }]);
    });

    it('drops empty timestamped lines unless asked to keep them', () => {
        expect(parseLrc('[00:01.00]\n[00:02.00]Text').lines).toEqual([{ time: 2, text: 'Text' }]);
        expect(parseLrc('[00:01.00]\n[00:02.00]Text', { includeEmpty: true }).lines).toEqual([{ time: 1, text: '' }, { time: 2, text: 'Text' }]);
    });

    it('treats text without timestamps as unsynced plain lyrics, blank lines kept', () => {
        const lrc = parseLrc('\n\nLine one  \n\nLine two\r\nLine three\n\n');
        expect(lrc.synced).toBe(false);
        expect(lrc.lines).toEqual([]);
        expect(lrc.plain).toBe('Line one\n\nLine two\nLine three');
    });

    it('keeps bracketed section headers and unknown [key:] lines as text', () => {
        const text = '[ti:Song]\n[Verse 1]\nfirst\n\n[Chorus: Alice]\nla la\n[Bridge]\n[note: keep me]\n[00:01.00]timed';
        const lrc = parseLrc(text);
        expect(lrc.meta).toEqual({ ti: 'Song' });
        expect(lrc.plain).toBe('[Verse 1]\nfirst\n\n[Chorus: Alice]\nla la\n[Bridge]\n[note: keep me]\ntimed');
        expect(lrc.lines).toEqual([{ time: 1, text: 'timed' }]);
        expect(parseLrc('[Chorus: X]\nwords').synced).toBe(false);
        expect(parseLrc('[Chorus: X]\nwords').plain).toBe('[Chorus: X]\nwords');
    });

    it('recognises only the known metadata keys, case-insensitively', () => {
        expect(META_KEYS).toEqual(['ti', 'ar', 'al', 'by', 'offset', 'length', 're', 've', 'au']);
        const lrc = parseLrc('[TI:T]\n[Ar:A]\n[AL:L]\n[BY:B]\n[LENGTH:03:00]\n[RE:editor]\n[ve:1.0]\n[au:writer]\n[OFFSET:+100]\n[00:01.00]x');
        expect(lrc.meta).toEqual({ ti: 'T', ar: 'A', al: 'L', by: 'B', length: '03:00', re: 'editor', ve: '1.0', au: 'writer' });
        expect(lrc.offset).toBe(100);
        expect(lrc.plain).toBe('x');
    });

    it('plainText keeps a plain document as written minus outer blank lines', () => {
        expect(plainText('\uFEFF\n[Chorus]\nla  \n\nla\n\n')).toBe('[Chorus]\nla\n\nla');
        expect(plainText('')).toBe('');
    });

    it('handles BOM, CRLF and empty input', () => {
        expect(parseLrc('﻿[00:01.00]A\r\n[00:02.00]B\r\n').lines).toHaveLength(2);
        expect(parseLrc('')).toEqual({ synced: false, lines: [], meta: {}, offset: 0, plain: '' });
        expect(parseLrc(null).synced).toBe(false);
    });

    it('isSyncedLrc', () => {
        expect(isSyncedLrc('[00:01.00]x')).toBe(true);
        expect(isSyncedLrc('just words')).toBe(false);
        expect(isSyncedLrc('[ti:only meta]')).toBe(false);
    });
});

describe('serializeLrc', () => {
    it('writes metadata then sorted lines with two decimals by default', () => {
        const text = serializeLrc({ meta: { ar: 'A', ti: 'T' }, lines: [{ time: 63.5, text: 'Second' }, { time: 12, text: 'First' }] });
        expect(text).toBe('[ti:T]\n[ar:A]\n[00:12.00]First\n[01:03.50]Second\n');
    });

    it('switches to millisecond precision when a time needs it and round-trips', () => {
        const lines = [{ time: 120.123, text: 'Third' }, { time: 1.5, text: 'x' }];
        const text = serializeLrc({ lines });
        expect(text).toBe('[00:01.500]x\n[02:00.123]Third\n');
        expect(parseLrc(text).lines).toEqual([{ time: 1.5, text: 'x' }, { time: 120.123, text: 'Third' }]);
    });

    it('formatLrcTime handles rounding at the minute boundary', () => {
        expect(formatLrcTime(59.999)).toBe('[01:00.00]');
        expect(formatLrcTime(59.999, 3)).toBe('[00:59.999]');
        expect(formatLrcTime(-3)).toBe('[00:00.00]');
    });

    it('serializes an empty document as empty text', () => {
        expect(serializeLrc({ lines: [] })).toBe('');
    });

    it('never lets a metadata value close its own tag', () => {
        const text = serializeLrc({ meta: { ti: 'T]\n[00:00.00]evil', ar: ']]]', by: 'ok' }, lines: [{ time: 1, text: 'x' }] });
        expect(text).toBe('[ti:T[00:00.00evil]\n[by:ok]\n[00:01.00]x\n');
        const back = parseLrc(text);
        expect(back.meta).toEqual({ ti: 'T[00:00.00evil', by: 'ok' });   // still one metadata line, no injected timed line
        expect(back.lines).toEqual([{ time: 1, text: 'x' }]);
    });
});

describe('activeLineIndex', () => {
    const lines = [{ time: 1 }, { time: 5 }, { time: 9 }];
    it('finds the last line at or before the time', () => {
        expect(activeLineIndex(lines, 0)).toBe(-1);
        expect(activeLineIndex(lines, 1)).toBe(0);
        expect(activeLineIndex(lines, 4.99)).toBe(0);
        expect(activeLineIndex(lines, 5)).toBe(1);
        expect(activeLineIndex(lines, 100)).toBe(2);
        expect(activeLineIndex([], 3)).toBe(-1);
    });
});
