// Phone side of "which address do I talk to" (#25). Discovery (mDNS) is only a hint: a
// desktop advertises a salted hash of its id, and a device claiming to be our desktop is
// believed only once it completes an authenticated exchange. Pure functions, tested.

import { discoveryTag } from './crypto.mjs';

/** Resolves the paired peer id a discovered service claims to be, or null. */
export const matchDiscovered = async (service, peers) => {
    if (!service || typeof service.salt !== 'string' || typeof service.tag !== 'string') return null;
    for (const peer of peers || []) {
        if (peer && typeof peer.deviceId === 'string' && (await discoveryTag(peer.deviceId, service.salt)) === service.tag) return peer.deviceId;
    }
    return null;
};

/**
 * Addresses to try for `peer`, in order: an explicit endpoint, then every discovered service
 * claiming to be it, then the address the last successful sync used. Duplicates removed.
 */
export const chooseEndpoints = (peer, discovered = [], explicit = null) => {
    const out = [];
    const seen = new Set();
    const add = (host, port, source) => {
        if (!host || !port) return;
        const id = `${host}:${port}`;
        if (seen.has(id)) return;
        seen.add(id);
        out.push({ host, port: Number(port), source });
    };
    if (explicit) add(explicit.host, explicit.port, 'manual');
    for (const d of discovered) if (d && d.peerId === peer.deviceId) add(d.host, d.port, 'discovery');
    if (peer.host && peer.port) add(peer.host, peer.port, 'last');
    return out;
};

export const sameAddress = (a, b) => !!a && !!b && a.host === b.host && Number(a.port) === Number(b.port);

/** Whether a failure at this endpoint should make the caller try the next one. */
export const shouldTryNext = (error) => ['network', 'unauthorized', 'unverified', 'refused'].includes(error?.code);

/**
 * Consecutive unverifiable replies from the known address after which the desktop's sync
 * data is presumed out of date (a restored backup rolled its counters or keys back; see
 * README "Backups and counter rollback") rather than a one-off glitch.
 */
export const STALE_DESKTOP_AFTER = 3;

/**
 * The peer record patch after an attempt at the known address: a reply that could not be
 * verified there extends the streak, any other outcome clears it.
 */
export const unverifiedStreak = (peer, error, endpoint) => (error?.code === 'unverified' && sameAddress(endpoint, peer) ? (peer?.unverifiedStreak || 0) + 1 : 0);

/**
 * One sentence for the user. A device that claims to be the desktop (via discovery) but fails
 * authentication at an address other than the last known one is reported as an impostor, not
 * as "pair again"; the "pair again" wording is reserved for the known address rejecting us,
 * or for its replies failing verification STALE_DESKTOP_AFTER times in a row
 * (`peer.unverifiedStreak`, counting this failure).
 */
export const describeSyncFailure = ({ error, endpoint, peer }) => {
    const name = peer?.name || 'the desktop';
    const where = endpoint ? `${endpoint.host}:${endpoint.port}` : '';
    const code = error?.code;
    const knownAddress = sameAddress(endpoint, peer);
    if (code === 'unauthorized' || code === 'unverified') {
        if (endpoint && !knownAddress) {
            return `A device on your network at ${where} claims to be "${name}" but could not prove it. It was ignored; nothing was applied.`;
        }
        if (code === 'unauthorized') return `${name} no longer recognises this phone (it may have been unpaired there). Unpair it here and pair again.`;
        if ((peer?.unverifiedStreak || 0) >= STALE_DESKTOP_AFTER) {
            return `This computer's sync data looks out of date (its replies could not be verified ${peer.unverifiedStreak} times in a row; was it restored from a backup?). Unpair ${name} here and pair again.`;
        }
        return `The reply from ${name} could not be verified; nothing was applied.`;
    }
    if (code === 'network') return `Could not reach ${name}${where ? ` at ${where}` : ''}. Check that both devices are on the same Wi-Fi and that Sync is switched on there.`;
    if (code === 'missing_key') return `The pairing key for ${name} is missing on this phone. Unpair it and pair again.`;
    if (code === 'transient') return `The pairing key for ${name} could not be read right now (${error.message}). Try again.`;
    return error?.message || String(error || 'Sync failed');
};
