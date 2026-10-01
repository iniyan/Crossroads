import { describe, expect, it } from 'vitest';
import { discoveryTag } from '../crypto.mjs';
import { STALE_DESKTOP_AFTER, chooseEndpoints, describeSyncFailure, matchDiscovered, shouldTryNext, unverifiedStreak } from '../endpoints.js';

const peer = { deviceId: 'desk-1', name: 'Studio Mac', host: '192.168.1.20', port: 51234 };

describe('discovery hints (fix 16, 23)', () => {
    it('matches a service by the salted tag only, never by a plain id', async () => {
        const salt = 'abcd1234';
        const tag = await discoveryTag('desk-1', salt);
        expect(await matchDiscovered({ salt, tag }, [peer])).toBe('desk-1');
        expect(await matchDiscovered({ salt: 'other', tag }, [peer])).toBeNull();
        expect(await matchDiscovered({ salt, tag: 'ffff' }, [peer])).toBeNull();
        expect(await matchDiscovered({ deviceId: 'desk-1' }, [peer])).toBeNull();
        expect(await matchDiscovered({ salt, tag }, [])).toBeNull();
        expect(await matchDiscovered(null, [peer])).toBeNull();
    });

    it('tries an explicit address, then matching discovered services, then the last known one', () => {
        const discovered = [
            { name: 'Crossroads', host: '192.168.1.30', port: 60000, peerId: 'desk-1' },
            { name: 'Other', host: '192.168.1.31', port: 60001, peerId: 'desk-2' },
            { name: 'Dup', host: '192.168.1.20', port: 51234, peerId: 'desk-1' }
        ];
        expect(chooseEndpoints(peer, discovered)).toEqual([
            { host: '192.168.1.30', port: 60000, source: 'discovery' },
            { host: '192.168.1.20', port: 51234, source: 'discovery' }
        ]);
        expect(chooseEndpoints(peer, [])).toEqual([{ host: '192.168.1.20', port: 51234, source: 'last' }]);
        expect(chooseEndpoints(peer, discovered, { host: '10.0.2.2', port: 1 })[0]).toEqual({ host: '10.0.2.2', port: 1, source: 'manual' });
        expect(chooseEndpoints({ deviceId: 'desk-1' }, [])).toEqual([]);
    });

    it('moves on after auth or network failures, stops on anything else', () => {
        for (const code of ['network', 'unauthorized', 'unverified', 'refused']) expect(shouldTryNext({ code })).toBe(true);
        for (const code of ['rate', 'busy', 'too_large', 'server', 'protocol', 'limit', undefined]) expect(shouldTryNext({ code })).toBe(false);
        expect(shouldTryNext(null)).toBe(false);
    });

    it('calls out an impostor, and says "pair again" only for the known address', () => {
        const impostor = { host: '192.168.1.99', port: 7, source: 'discovery' };
        const known = { host: '192.168.1.20', port: 51234, source: 'last' };
        const unauthorized = { code: 'unauthorized', message: 'x' };
        expect(describeSyncFailure({ error: unauthorized, endpoint: impostor, peer })).toMatch(/192\.168\.1\.99:7 claims to be "Studio Mac" but could not prove it/);
        expect(describeSyncFailure({ error: unauthorized, endpoint: impostor, peer })).not.toMatch(/pair again/i);
        expect(describeSyncFailure({ error: { code: 'unverified' }, endpoint: impostor, peer })).toMatch(/claims to be/);
        expect(describeSyncFailure({ error: unauthorized, endpoint: known, peer })).toMatch(/no longer recognises this phone.*pair again/);
        expect(describeSyncFailure({ error: { code: 'unverified' }, endpoint: known, peer })).toMatch(/could not be verified/);
        expect(describeSyncFailure({ error: { code: 'network' }, endpoint: known, peer })).toMatch(/Could not reach Studio Mac at 192\.168\.1\.20:51234/);
        expect(describeSyncFailure({ error: { code: 'missing_key' }, endpoint: null, peer })).toMatch(/key.*missing.*pair again/i);
        expect(describeSyncFailure({ error: { code: 'transient', message: 'keystore busy' }, endpoint: null, peer })).toMatch(/keystore busy.*Try again/);
        expect(describeSyncFailure({ error: { code: 'rate', message: 'slow down' }, endpoint: known, peer })).toBe('slow down');
        expect(describeSyncFailure({ error: { code: 'too_large', message: 'too big' }, endpoint: known, peer })).toBe('too big');
    });

    it('calls a desktop whose replies keep failing verification at the known address out of date (P3)', () => {
        const known = { host: '192.168.1.20', port: 51234, source: 'last' };
        const impostor = { host: '192.168.1.99', port: 7, source: 'discovery' };
        const unverified = { code: 'unverified', message: 'replay' };
        // the streak counts only unverifiable replies from the known address
        expect(unverifiedStreak(peer, unverified, known)).toBe(1);
        expect(unverifiedStreak({ ...peer, unverifiedStreak: 2 }, unverified, known)).toBe(3);
        expect(unverifiedStreak({ ...peer, unverifiedStreak: 2 }, unverified, impostor)).toBe(0);
        expect(unverifiedStreak({ ...peer, unverifiedStreak: 2 }, { code: 'unauthorized' }, known)).toBe(0);
        expect(unverifiedStreak({ ...peer, unverifiedStreak: 2 }, { code: 'network' }, known)).toBe(0);
        expect(unverifiedStreak({ ...peer, unverifiedStreak: 2 }, null, known)).toBe(0);
        // below the threshold: the generic wording; at it: the explicit one
        for (let n = 1; n < STALE_DESKTOP_AFTER; n++) {
            const msg = describeSyncFailure({ error: unverified, endpoint: known, peer: { ...peer, unverifiedStreak: n } });
            expect(msg).toMatch(/could not be verified; nothing was applied/);
            expect(msg).not.toMatch(/out of date/);
        }
        const stale = describeSyncFailure({ error: unverified, endpoint: known, peer: { ...peer, unverifiedStreak: STALE_DESKTOP_AFTER } });
        expect(stale).toMatch(/This computer's sync data looks out of date/);
        expect(stale).toMatch(/Unpair Studio Mac here and pair again/);
        expect(stale).toMatch(/3 times in a row/);
        // never for an impostor address, even with a streak on record
        expect(describeSyncFailure({ error: unverified, endpoint: impostor, peer: { ...peer, unverifiedStreak: 9 } })).toMatch(/claims to be/);
    });
});
