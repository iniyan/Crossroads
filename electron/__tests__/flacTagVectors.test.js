// The shared vectors (android/app/src/test/resources/flac-vectors.txt) pin the writer's output
// byte-for-byte; the Java writer is checked against the same file. Regenerate with
// `node scripts/generateFlacVectors.mjs` after an intentional behaviour change.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildFile, readTags } from '../flacTagWriter.js';

const VECTORS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../android/app/src/test/resources/flac-vectors.txt');

const utf8 = (b64) => Buffer.from(b64 || '', 'base64').toString('utf8');

export function parseVectors(text) {
    const vectors = [];
    let cur = null;
    for (const raw of text.split('\n')) {
        const line = raw.trimEnd();
        if (!line || line.startsWith('#')) continue;
        const sp = line.indexOf(' ');
        const cmd = sp < 0 ? line : line.slice(0, sp);
        const rest = sp < 0 ? '' : line.slice(sp + 1);
        switch (cmd) {
            case 'vector': cur = { name: rest, ops: { set: {}, remove: [] }, tags: {}, padding: 8192 }; break;
            case 'input': cur.input = Buffer.from(rest, 'base64'); break;
            case 'padding': cur.padding = Number(rest); break;
            case 'set': {
                const [key, b64 = ''] = rest.split(' ', 2).map(utf8);
                (cur.ops.set[key] = cur.ops.set[key] || []).push(b64);
                break;
            }
            case 'clear': cur.ops.set[utf8(rest)] = []; break;
            case 'remove': cur.ops.remove.push(utf8(rest)); break;
            case 'expect': {
                const m = /^sha256 ([0-9a-f]+) inPlace (true|false) vendor (.*)$/.exec(rest);
                cur.sha256 = m[1];
                cur.inPlace = m[2] === 'true';
                cur.vendor = Buffer.from(m[3], 'base64').toString('utf8');
                break;
            }
            case 'tag': {
                const [key, value = ''] = rest.split(' ', 2).map(utf8);
                (cur.tags[key] = cur.tags[key] || []).push(value);
                break;
            }
            case 'end': vectors.push(cur); cur = null; break;
            default: throw new Error(`Unknown vector line: ${line}`);
        }
    }
    return vectors;
}

describe('shared FLAC tag-writer vectors', () => {
    const vectors = fs.existsSync(VECTORS) ? parseVectors(fs.readFileSync(VECTORS, 'utf8')) : [];

    it('has vectors', () => {
        expect(vectors.length).toBeGreaterThan(10);
    });

    for (const v of vectors) {
        it(`produces the pinned output for ${v.name}`, () => {
            const { file, plan } = buildFile(v.input, v.ops, { padding: v.padding });
            expect(plan.inPlace).toBe(v.inPlace);
            expect(crypto.createHash('sha256').update(file).digest('hex')).toBe(v.sha256);
            const back = readTags(file);
            expect(back.vendor).toBe(v.vendor);
            expect(back.tags).toEqual(v.tags);
            expect(plan.tags).toEqual(v.tags);
        });
    }
});
