import { describe, expect, it } from 'vitest';
import { compareHlc, createClock, isHlc, receive, tick } from '../hlc.js';

describe('hlc', () => {
    it('ticks monotonically even when the wall clock stalls or goes back', () => {
        let clock = createClock('a');
        const a = (clock = tick(clock, 1000));
        const b = (clock = tick(clock, 1000));
        const c = (clock = tick(clock, 500));
        const d = (clock = tick(clock, 2000));
        expect(compareHlc(a, b)).toBe(-1);
        expect(compareHlc(b, c)).toBe(-1);
        expect(compareHlc(c, d)).toBe(-1);
        expect(d).toEqual({ w: 2000, c: 0, d: 'a' });
    });

    it('receive advances past a remote timestamp from a skewed clock', () => {
        let clock = createClock('a');
        clock = tick(clock, 1000);
        clock = receive(clock, { w: 5000, c: 3, d: 'b' }, 1000);
        expect(clock).toEqual({ w: 5000, c: 4, d: 'a' });
        const later = tick(clock, 1001);
        expect(compareHlc(later, { w: 5000, c: 3, d: 'b' })).toBe(1);
        // same wall on both sides: counter exceeds both
        expect(receive({ w: 7, c: 9, d: 'a' }, { w: 7, c: 2, d: 'b' }, 7)).toEqual({ w: 7, c: 10, d: 'a' });
        // wall clock ahead of both
        expect(receive({ w: 7, c: 9, d: 'a' }, { w: 7, c: 2, d: 'b' }, 8)).toEqual({ w: 8, c: 0, d: 'a' });
    });

    it('orders by wall, counter, then device id (total order)', () => {
        expect(compareHlc({ w: 1, c: 0, d: 'z' }, { w: 2, c: 0, d: 'a' })).toBe(-1);
        expect(compareHlc({ w: 1, c: 1, d: 'a' }, { w: 1, c: 0, d: 'z' })).toBe(1);
        expect(compareHlc({ w: 1, c: 1, d: 'a' }, { w: 1, c: 1, d: 'b' })).toBe(-1);
        expect(compareHlc({ w: 1, c: 1, d: 'b' }, { w: 1, c: 1, d: 'b' })).toBe(0);
    });

    it('validates shape and restores a saved clock', () => {
        expect(isHlc({ w: 1, c: 0, d: 'x' })).toBe(true);
        expect(isHlc({ w: -1, c: 0, d: 'x' })).toBe(false);
        expect(isHlc({ w: 1.5, c: 0, d: 'x' })).toBe(false);
        expect(isHlc({ w: 1, c: 0, d: '' })).toBe(false);
        expect(isHlc(null)).toBe(false);
        expect(createClock('d', { w: 10, c: 2 })).toEqual({ w: 10, c: 2, d: 'd' });
        expect(createClock('d', { w: 'no' })).toEqual({ w: 0, c: 0, d: 'd' });
    });
});
