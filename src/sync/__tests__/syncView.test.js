// The Sync view rendered to static markup: every device name must sit in its own isolated
// left-to-right element and the pairing code must be a block of its own, never inline with a
// name (C6: a crafted name must not be able to reorder or absorb the digits).
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The view only needs parseHostPort from the hook module, which drags in the platform layer
// (touches `window` at import time); neither is exercised by static rendering.
vi.mock('../../services/PlatformService', () => ({ default: { sync: { mode: null, host: null } } }));
vi.mock('../../services/blobStore.js', () => ({ getBlob: async () => null, setBlob: async () => {}, deleteBlob: async () => {} }));

const { default: SyncView } = await import('../../components/SyncView.jsx');

const nameSpan = (text) => new RegExp(`<(span|strong) class="sync-name" dir="ltr">${text}</(span|strong)>`);
const noop = () => {};

const hostSync = (session) => ({
    mode: 'host', loaded: true, deviceId: 'desk-1', deviceName: 'Studio‮ Mac',
    hostStatus: { enabled: true, running: true, port: 5000, name: 'Studio‮ Mac', addresses: [], pairing: { open: true, locked: false, lockReason: null, expiresAt: Date.now() + 60000, attemptsLeft: 4, session } },
    setHostingEnabled: noop, setDeviceName: noop, openPairing: noop, closePairing: noop, confirmPairing: noop,
    peers: [{ deviceId: 'phone-1', name: 'Pixel​‮', pairedAt: 1, lastSyncAt: null }],
    discovered: [], discovering: false, acquireDiscovery: () => noop,
    pairing: null, pairWith: noop, confirmPairingCode: noop, cancelPairing: noop, syncNow: noop, syncing: false,
    autoSync: false, setAutoSync: noop, unpair: noop, lastResult: { at: Date.now(), peerName: 'Pixel‮', text: 'ok' }, unmatched: 0
});

describe('SyncView name isolation (C6)', () => {
    it('renders the desktop pairing screen with isolated names and the code on its own line', () => {
        const session = { id: 's', clientId: 'phone-1', clientName: 'Pixel‮ 123', fingerprint: 'ab12 cd34', code: '987654', status: 'compare', error: null };
        const html = renderToStaticMarkup(React.createElement(SyncView, { sync: hostSync(session) }));
        expect(html).not.toMatch(/[‮​]/);
        expect(html).toMatch(nameSpan('Pixel 123'));                   // session.clientName
        expect(html).toMatch(nameSpan('Pixel'));                       // peer list and result line
        expect(html).toMatch(nameSpan('Studio Mac'));                  // the desktop's own name
        expect(html).toMatch(/<div class="sync-code" dir="ltr">987 654<\/div>/);
        expect(html).toMatch(/<span class="sync-fingerprint" dir="ltr"[^>]*>ab12 cd34<\/span>/);
        // the code block is a sibling of the text line, not inside it
        const codeAt = html.indexOf('<div class="sync-code"');
        const before = html.slice(0, codeAt);
        expect(before.endsWith('</div>')).toBe(true);
        expect(html.slice(codeAt)).toMatch(/^<div class="sync-code" dir="ltr">987 654<\/div><div class="sync-actions">/);
    });

    it('renders the confirmed state with the code on its own line too', () => {
        const session = { id: 's', clientId: 'phone-1', clientName: 'Pixel', fingerprint: 'ab12 cd34', code: '112233', status: 'confirmed', error: null };
        const html = renderToStaticMarkup(React.createElement(SyncView, { sync: hostSync(session) }));
        expect(html).toMatch(/Waiting for <strong class="sync-name" dir="ltr">Pixel<\/strong> .*? to confirm this code\.\.\.<\/div><div class="sync-code" dir="ltr">112 233<\/div>/);
    });

    it('renders the phone pairing screen and discovered desktops with isolated names', () => {
        const sync = {
            ...hostSync(null), mode: 'client', hostStatus: null, deviceName: 'My‮phone',
            peers: [{ deviceId: 'desk-1', name: 'Studio‮ Mac', host: '192.168.1.2', port: 5000, pairedAt: 1, lastSyncAt: null }],
            discovered: [{ name: 'Evil‮ desk', label: 'Evil desk', host: '192.168.1.9', port: 7, peerId: null }],
            pairing: { status: 'compare', code: '123456', serverName: 'Studio‮ Mac', fingerprint: 'ab12 cd34', host: '192.168.1.2', port: 5000, confirmed: false }
        };
        const html = renderToStaticMarkup(React.createElement(SyncView, { sync }));
        expect(html).not.toMatch(/[‮​]/);
        expect(html).toMatch(nameSpan('Studio Mac'));
        expect(html).toMatch(nameSpan('Myphone'));
        expect(html).toMatch(/Both screens must show this code:<\/div><div class="sync-code" dir="ltr">123 456<\/div>/);
        // the discovered list (shown while no pairing is in progress): the mDNS name is attacker-controlled
        const idle = renderToStaticMarkup(React.createElement(SyncView, { sync: { ...sync, pairing: null } }));
        expect(idle).not.toMatch(/[‮​]/);
        expect(idle).toMatch(nameSpan('Evil desk'));
        expect(idle).toMatch(/<span class="sync-muted" dir="ltr">192\.168\.1\.9:7<\/span>/);
    });
});
