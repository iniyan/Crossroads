import { describe, expect, it } from 'vitest';
import { MAX_DISPLAY_NAME, cleanDisplayName } from '../names.mjs';
import { cleanDeviceName } from '../../../electron/sync/peerStore.mjs';

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿؜᠎\p{Cc}\p{Cf}]/u;

describe('cleanDisplayName (C6)', () => {
    it('strips controls, bidi and zero-width characters and collapses whitespace', () => {
        expect(cleanDisplayName('Pixel‮​ 123 456')).toBe('Pixel 123 456');
        const hostile = '‪‫‬‭‮⁦⁧⁨⁩​‌‍‎‏﻿؜᠎⁠­\u0000\u001f\u007f\u0085\u009f';
        expect(cleanDisplayName(`a${hostile}b`)).toBe('ab');
        expect(cleanDisplayName(hostile)).toBe('');
        expect(cleanDisplayName('  Studio \t\n  Mac   2   ')).toBe('Studio Mac 2');
        expect(INVISIBLE.test(cleanDisplayName('x‮y​z⁦'))).toBe(false);
    });

    it('keeps ordinary Unicode (RTL scripts, accents, emoji) and caps the length', () => {
        expect(cleanDisplayName('Téléphone de Zoë')).toBe('Téléphone de Zoë');
        expect(cleanDisplayName('هاتف أحمد')).toBe('هاتف أحمد');
        expect(cleanDisplayName('מחשב')).toBe('מחשב');
        expect(cleanDisplayName('Pixel 📱')).toBe('Pixel 📱');
        expect(cleanDisplayName('n'.repeat(500))).toHaveLength(MAX_DISPLAY_NAME);
        expect(cleanDisplayName('n'.repeat(500), 10)).toBe('nnnnnnnnnn');
        expect(cleanDisplayName(`${'a'.repeat(63)} b`, 64)).toBe('a'.repeat(63));   // no trailing space after the cut
    });

    it('returns an empty string for anything that is not a usable string', () => {
        for (const v of [null, undefined, 42, {}, [], '', '   ', '​']) expect(cleanDisplayName(v)).toBe('');
    });

    it('is what the desktop peer store applies to the device name (48 chars)', () => {
        expect(cleanDeviceName('Studio‮ Mac')).toBe('Studio Mac');
        expect(cleanDeviceName('x'.repeat(100))).toHaveLength(48);
        expect(cleanDeviceName('\u0000')).toBe('');
    });
});
