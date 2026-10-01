// mDNS / DNS-SD advertisement of the sync server as _crossroads._tcp (#25), via
// bonjour-service (MIT, pure JS on top of multicast-dns; coexists with the OS responder).
//
// Privacy: the instance name is the user-editable device name (default "Crossroads", never the
// hostname), and the TXT record carries no device id: only { v, s, h } where `s` is a salt
// minted every time hosting starts and `h` = discoveryTag(deviceId, s). A paired phone, which
// knows the desktop's id, recomputes `h` to spot its desktop; anyone else sees a value that
// changes on every start. It is a hint only: the phone proves the desktop's identity with the
// encrypted exchange (crypto.mjs).

import { Bonjour } from 'bonjour-service';
import { PROTOCOL_VERSION, SERVICE_TYPE } from './server.mjs';

export const createAdvertiser = ({ log = console } = {}) => {
    let bonjour = null;
    let service = null;

    const stop = () => new Promise((resolve) => {
        const b = bonjour;
        bonjour = null;
        service = null;
        if (!b) return resolve();
        b.unpublishAll(() => { b.destroy(); resolve(); });
        // unpublishAll's goodbye packets can hang when the network is gone: never block shutdown.
        setTimeout(() => { try { b.destroy(); } catch { /* already destroyed */ } resolve(); }, 1500).unref?.();
    });

    /** @param {{ name: string, port: number, salt: string, tag: string }} record */
    const publish = async ({ name, port, salt, tag }) => {
        await stop();
        bonjour = new Bonjour({}, (e) => log.warn?.('sync: mDNS error', e?.message || e));
        service = bonjour.publish({
            name,
            type: SERVICE_TYPE,
            port,
            txt: { v: String(PROTOCOL_VERSION), s: salt, h: tag }
        });
        service.on('error', (e) => log.warn?.('sync: mDNS publish error', e?.message || e));
        return service;
    };

    return { publish, stop, get active() { return !!service; } };
};
