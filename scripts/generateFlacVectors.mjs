#!/usr/bin/env node
// Generates the shared FLAC tag-writer test vectors consumed by both
//   electron/__tests__/flacTagVectors.test.js   (JS writer)
//   android/app/src/test/java/.../FlacTagWriterVectorsTest.java  (Java writer)
// so the two implementations are held to byte-identical output. Needs ffmpeg.
//
//   node scripts/generateFlacVectors.mjs
//
// Format (android/app/src/test/resources/flac-vectors.txt), one record per vector, all
// binary/unicode payloads base64-encoded so no JSON parser is needed on the JVM:
//   vector <name>
//   input <base64 of the original file>
//   padding <n>                       (rewrite padding option)
//   set <base64 key> <base64 value>   (repeatable; several lines = several values)
//   clear <base64 key>                (set with an empty value list)
//   remove <base64 key>
//   expect sha256 <hex> inPlace <true|false> vendor <base64>
//   tag <base64 key> <base64 value>   (repeatable: the tags read back, in key order)
//   end
// Keys are base64 too so spellings with spaces or non-ASCII can be pinned.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildFile, readTags } from '../electron/flacTagWriter.js';
import { hasFfmpeg, makeFlac, withPadding, withBlockAfterStreamInfo, withoutVorbisComment, withId3v2, vorbisCommentBody } from '../electron/__tests__/helpers/flacFixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../android/app/src/test/resources/flac-vectors.txt');

if (!hasFfmpeg()) {
    console.error('ffmpeg is required to generate the vectors');
    process.exit(1);
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const cases = [
    { name: 'add-tags-into-padding', input: withPadding(makeFlac({ tags: { title: 'Orig', artist: 'Band' } }), 4096), ops: { set: { ALBUM: 'Album', DATE: '2001', PERFORMER: ['Violin: A', 'Cello: B'] } } },
    { name: 'remove-and-replace', input: withPadding(makeFlac({ tags: { title: 'Orig', artist: 'Band', comment: 'drop me' } }), 512), ops: { set: { artist: 'New Band' }, remove: ['Description'] } },
    { name: 'no-padding-forces-rewrite', input: makeFlac({ tags: { title: 'T' } }), ops: { set: { LYRICS: '[00:01.00]line one\n[00:02.50]line two' } } },
    { name: 'custom-rewrite-padding', input: makeFlac({ tags: { title: 'T' } }), ops: { set: { COMMENT: 'x'.repeat(100) } }, padding: 100 },
    { name: 'exact-fit-drops-padding', input: withPadding(makeFlac({ tags: { title: 'T' } }), 20), ops: { set: { ALBUM: 'abcdefghijklmn' } } },
    { name: 'leftover-below-4-rewrites', input: withPadding(makeFlac({ tags: { title: 'T' } }), 20), ops: { set: { ALBUM: 'x'.repeat(12) } } },
    { name: 'unicode-and-multivalue', input: withPadding(makeFlac({ tags: { title: 'T' } }), 2000), ops: { set: { TITLE: 'Jóga – Björk 東京 🎵', PERFORMER: ['Violin: Ånna', 'Cello: Bö'], COMMENT: 'a=b=c' } } },
    { name: 'picture-preserved-rewrite', input: makeFlac({ tags: { title: 'Pic' }, picture: true }), ops: { set: { ARTIST: ['A', 'B'], LYRICS: 'la '.repeat(1500) } } },
    { name: 'picture-preserved-in-place', input: withPadding(makeFlac({ tags: { title: 'Pic' }, picture: true }), 300), ops: { set: { GENRE: 'Ambient' } } },
    { name: 'no-vorbis-comment-block', input: withoutVorbisComment(withPadding(makeFlac({ tags: { title: 'Gone' } }), 500)), ops: { set: { TITLE: 'Fresh', ARTIST: 'New' } } },
    // Entries without a "KEY=" part are kept verbatim (after the key=value entries).
    { name: 'raw-entries-preserved', input: withPadding(withBlockAfterStreamInfo(withoutVorbisComment(makeFlac({ tags: { title: 'A' } })), 4, vorbisCommentBody('vend', ['TITLE=a', 'noequals', '=novalue', 'ARTIST=x', 'title=b'])), 512), ops: { set: { artist: 'y' } } },
    // Keys already in the file are edited by their trimmed upper-cased spelling even when they are not legal names.
    { name: 'weird-existing-keys', input: withPadding(withBlockAfterStreamInfo(withoutVorbisComment(makeFlac({ tags: { title: 'A' } })), 4, vorbisCommentBody('vend', ['TITLE =old', 'WEIRD~KEY=1', 'ÜBER=2', 'Über=3', 'ARTIST=x'])), 512), ops: { set: { 'WEIRD~KEY': '4', ' title': 'new', ' composer ': 'C' }, remove: ['über'] } },
    // "Blank" is the JS trim set: U+001C..U+001F are values, NBSP / em space / BOM / ideographic space are blank.
    { name: 'edge-whitespace-values', input: withPadding(makeFlac({ tags: { title: 'T', album: 'Old', genre: 'G' } }), 1024), ops: { set: { TITLE: '\u001C', ARTIST: ['\u00A0\u2003', '\u001F', ' kept '], ALBUM: '\uFEFF', GENRE: ['\u3000', '\u2028\u2029', '\u000B\u000C'], COMMENT: ' \u3000x\u2028 ', DATE: '\u180E' } } },
    { name: 'application-block-and-padding-merge', input: withPadding(withBlockAfterStreamInfo(withPadding(makeFlac({ tags: { title: 'App' } }), 40), 2, Buffer.concat([Buffer.from('CROS'), Buffer.alloc(30, 7)])), 60), ops: { set: { TITLE: 'App2' } } },
    { name: 'id3v2-prefix-kept', input: withId3v2(withPadding(makeFlac({ tags: { title: 'Id3' } }), 100), 50), ops: { set: { ALBUM: 'Prefixed' } } },
    { name: 'shrink-grows-padding', input: makeFlac({ tags: { title: 'T', comment: 'x'.repeat(400) } }), ops: { remove: ['DESCRIPTION'] } },
    { name: 'clear-via-empty-list', input: withPadding(makeFlac({ tags: { title: 'T', artist: 'A' } }), 64), ops: { set: { ARTIST: [], TITLE: ['', 'Kept'] } } },
    { name: 'noop', input: withPadding(makeFlac({ tags: { title: 'Same' } }), 64), ops: { set: { title: 'Same' } } },
    { name: 'existing-key-spelling-kept', input: withPadding(makeFlac({ tags: { title: 'lower' } }), 64), ops: { set: { TITLE: 'Changed', zebra: 'z', ALPHA: 'a' } } },
    { name: 'stereo-24bit-96k', input: withPadding(makeFlac({ sampleRate: 96000, channels: 2, sampleFmt: 's32', duration: 0.1, tags: { title: 'Hi' } }), 128), ops: { set: { ALBUM: 'HR' } } },
    { name: 'huge-addition', input: makeFlac({ tags: { title: 'T' } }), ops: { set: { LYRICS: Array.from({ length: 2000 }, (_, i) => `[${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.00]line ${i}`).join('\n') } } }
];

const lines = ['# Generated by scripts/generateFlacVectors.mjs; do not edit by hand.'];
for (const c of cases) {
    const padding = c.padding ?? 8192;
    const { file, plan } = buildFile(c.input, c.ops, { padding });
    const { vendor, tags } = readTags(file);
    lines.push(`vector ${c.name}`);
    lines.push(`input ${c.input.toString('base64')}`);
    lines.push(`padding ${padding}`);
    for (const [key, raw] of Object.entries(c.ops.set || {})) {
        const values = Array.isArray(raw) ? raw : [raw];
        if (values.length === 0) lines.push(`clear ${b64(key)}`);
        for (const v of values) lines.push(`set ${b64(key)} ${b64(v)}`);
    }
    for (const key of c.ops.remove || []) lines.push(`remove ${b64(key)}`);
    lines.push(`expect sha256 ${sha(file)} inPlace ${plan.inPlace} vendor ${b64(vendor)}`);
    for (const [key, values] of Object.entries(tags)) for (const v of values) lines.push(`tag ${b64(key)} ${b64(v)}`);
    lines.push('end');
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`Wrote ${cases.length} vectors to ${OUT} (${fs.statSync(OUT).size} bytes)`);
