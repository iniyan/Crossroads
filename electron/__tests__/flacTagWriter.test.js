import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import fsp from 'node:fs/promises';   // the very object electron/flacTagWriter.js requires: patchable
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    FlacTagError, DEFAULT_PADDING, DEFAULT_VENDOR, JS_SPACE, jsTrim, isBlank, foldKey,
    parseMetadata, parseVorbisComment, applyTagOperations, groupComments, tagsObject, planTagWrite, buildFile,
    readTags, readFlacTags, writeFlacTags, renameWithRetry, hashAudio
} from '../flacTagWriter.js';
import {
    hasFfmpeg, makeFlac, listBlocks, withPadding, withBlockAfterStreamInfo, withoutVorbisComment,
    withId3v2, vorbisCommentBody, decodedMd5, decodesCleanly, ffmpegTags
} from './helpers/flacFixtures.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const audioOf = (buf) => buf.subarray(listBlocks(buf).audioOffset);
const streamInfoOf = (buf) => { const b = listBlocks(buf).blocks[0]; return buf.subarray(b.bodyStart, b.bodyStart + 34); };

const describeFfmpeg = hasFfmpeg() ? describe : describe.skip;

// A synthetic FLAC (no ffmpeg needed) for the pure-logic tests.
function syntheticFlac({ comments = ['TITLE=Song', 'ARTIST=Someone'], vendor = 'reference libFLAC 1.4.3', padding = null, extra = [] } = {}) {
    const streamInfo = Buffer.alloc(34);
    streamInfo.writeUInt16BE(4096, 0);
    streamInfo.writeUInt16BE(4096, 2);
    streamInfo.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n) | 12345n, 10);
    Buffer.alloc(16, 0xAB).copy(streamInfo, 18);
    const blocks = [{ type: 0, body: streamInfo }, { type: 4, body: vorbisCommentBody(vendor, comments) }, ...extra];
    if (padding !== null) blocks.push({ type: 1, body: Buffer.alloc(padding) });
    const parts = [Buffer.from('fLaC')];
    blocks.forEach((b, i) => {
        parts.push(Buffer.from([(i === blocks.length - 1 ? 0x80 : 0) | b.type, (b.body.length >> 16) & 0xFF, (b.body.length >> 8) & 0xFF, b.body.length & 0xFF]), b.body);
    });
    parts.push(Buffer.from('\xFF\xF8audio frames here'.repeat(20), 'latin1'));
    return Buffer.concat(parts);
}

describe('parseMetadata', () => {
    it('lists the blocks and the audio offset', () => {
        const buf = syntheticFlac({ padding: 100 });
        const parsed = parseMetadata(buf);
        expect(parsed.metaStart).toBe(4);
        expect(parsed.blocks.map(b => b.type)).toEqual([0, 4, 1]);
        expect(parsed.blocks[2].isLast).toBe(true);
        expect(parsed.audioOffset).toBe(listBlocks(buf).audioOffset);
    });

    it('tolerates an ID3v2 prefix', () => {
        const parsed = parseMetadata(withId3v2(syntheticFlac(), 30));
        expect(parsed.prefixLength).toBe(40);
        expect(parsed.metaStart).toBe(44);
    });

    it('rejects non-FLAC, truncated and STREAMINFO-less input', () => {
        expect(() => parseMetadata(Buffer.from('RIFF....WAVE'))).toThrow(FlacTagError);
        expect(() => parseMetadata(syntheticFlac().subarray(0, 20))).toThrow(/Truncated/);
        const noSi = Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x81, 0, 0, 2, 0, 0]), Buffer.from('audio')]);
        expect(() => parseMetadata(noSi)).toThrow(/STREAMINFO/);
    });
});

describe('applyTagOperations', () => {
    const existing = groupComments([['TITLE', 'Song'], ['Artist', 'A'], ['ARTIST', 'B'], ['genre', 'Rock']]);

    it('groups case-insensitively, keeping the first spelling', () => {
        expect(Array.from(existing.keys())).toEqual(['TITLE', 'ARTIST', 'GENRE']);
        expect(existing.get('ARTIST')).toEqual({ key: 'Artist', values: ['A', 'B'] });
        expect(tagsObject(existing)).toEqual({ TITLE: ['Song'], ARTIST: ['A', 'B'], GENRE: ['Rock'] });
    });

    it('replaces, removes and appends new keys upper-cased and alphabetically', () => {
        const out = applyTagOperations(existing, { set: { zzz: 'last', artist: ['C'], AAA: 'first' }, remove: ['Genre'] });
        expect(Array.from(out.keys())).toEqual(['TITLE', 'ARTIST', 'AAA', 'ZZZ']);
        expect(out.get('ARTIST')).toEqual({ key: 'Artist', values: ['C'] });
        expect(out.get('ZZZ')).toEqual({ key: 'ZZZ', values: ['last'] });
    });

    it('treats an empty value list as removal and drops blank values', () => {
        const out = applyTagOperations(existing, { set: { TITLE: [], GENRE: ['', '  ', 'Jazz'] } });
        expect(out.has('TITLE')).toBe(false);
        expect(out.get('GENRE')).toEqual({ key: 'genre', values: ['Jazz'] });
    });

    it('does not mutate the input map', () => {
        applyTagOperations(existing, { set: { ARTIST: 'X' } });
        expect(existing.get('ARTIST').values).toEqual(['A', 'B']);
    });

    it('rejects invalid NEW keys and invalid values', () => {
        expect(() => applyTagOperations(existing, { set: { 'BAD=KEY': 'x' } })).toThrow(/Invalid tag name/);
        expect(() => applyTagOperations(existing, { set: { 'Ünïcode': 'x' } })).toThrow(/Invalid tag name/);
        expect(() => applyTagOperations(existing, { set: { '': 'x' } })).toThrow(/Empty tag name/);
        expect(() => applyTagOperations(existing, { set: { '  ': 'x' } })).toThrow(/Empty tag name/);
        expect(() => applyTagOperations(existing, { remove: [''] })).toThrow(/Empty tag name/);
        expect(() => applyTagOperations(existing, { set: { TITLE: 'a\0b' } })).toThrow(/Invalid value/);
        expect(() => applyTagOperations(existing, { set: { TITLE: { nested: true } } })).toThrow(/Invalid value/);
        // Clearing or removing a key that is not in the file is a no-op whatever its spelling.
        expect(Array.from(applyTagOperations(existing, { set: { 'Ünïcode': [] }, remove: ['BAD=KEY'] }).keys())).toEqual(['TITLE', 'ARTIST', 'GENRE']);
    });

    it('edits keys already in the file by their trimmed upper-cased spelling, legal or not', () => {
        const weird = groupComments([['TITLE ', 'old'], ['WEIRD~KEY', '1'], ['ÜBER', '2'], ['Über', '3'], ['ARTIST', 'x']]);
        expect(Array.from(weird.keys())).toEqual(['TITLE', 'WEIRD~KEY', 'ÜBER', 'ARTIST']);
        expect(weird.get('ÜBER')).toEqual({ key: 'ÜBER', values: ['2', '3'] });
        const out = applyTagOperations(weird, { set: { 'WEIRD~KEY': '4', ' title': 'new', ' composer ': 'C' }, remove: ['über'] });
        expect(Array.from(out.keys())).toEqual(['TITLE', 'WEIRD~KEY', 'ARTIST', 'COMPOSER']);
        expect(out.get('TITLE')).toEqual({ key: 'TITLE ', values: ['new'] });
        expect(out.get('WEIRD~KEY')).toEqual({ key: 'WEIRD~KEY', values: ['4'] });
        expect(tagsObject(out)).toEqual({ TITLE: ['new'], 'WEIRD~KEY': ['4'], ARTIST: ['x'], COMPOSER: ['C'] });
    });

    it('defines "blank" as exactly the set String.prototype.trim() strips', () => {
        for (const code of JS_SPACE) {
            const ch = String.fromCharCode(code);
            expect(ch.trim()).toBe('');
            expect(isBlank(ch)).toBe(true);
        }
        for (const ch of ['\u001C', '\u001D', '\u001E', '\u001F', '\u180E', '\u200B', '\u0085', 'x']) {
            expect(ch.trim()).toBe(ch);
            expect(isBlank(ch)).toBe(false);
        }
        expect(isBlank('')).toBe(true);
        expect(jsTrim(' \u3000x\u2028 ')).toBe('x');
        expect(jsTrim('\u001Cx\u001F')).toBe('\u001Cx\u001F');
        expect(foldKey(' title\uFEFF')).toBe('TITLE');
        const out = applyTagOperations(existing, { set: { TITLE: '\u001C', ARTIST: ['\u00A0\u2003', '\u001F', ' kept '], GENRE: ['\u3000', '\u2028\u2029', '\u000B\u000C'] } });
        expect(tagsObject(out)).toEqual({ TITLE: ['\u001C'], ARTIST: ['\u001F', ' kept '] });
    });
});

describe('planTagWrite', () => {
    it('rewrites in place when the new block fits in the old padding', () => {
        const buf = syntheticFlac({ padding: 200 });
        const before = listBlocks(buf);
        const plan = planTagWrite(buf, { set: { ALBUM: 'Some Album' } });
        expect(plan.inPlace).toBe(true);
        expect(plan.metadata.length).toBe(plan.oldLength);
        const { file } = buildFile(buf, { set: { ALBUM: 'Some Album' } });
        const after = listBlocks(file);
        expect(after.audioOffset).toBe(before.audioOffset);
        expect(after.blocks.map(b => b.type)).toEqual([0, 4, 1]);
        expect(after.blocks[2].length).toBe(200 - (4 + 'ALBUM=Some Album'.length));
        expect(readTags(file).tags).toEqual({ TITLE: ['Song'], ARTIST: ['Someone'], ALBUM: ['Some Album'] });
    });

    it('drops the padding block entirely when the new comment fills the region exactly', () => {
        const buf = syntheticFlac({ padding: 20 });
        // The PADDING block is 4 + 20 bytes; a comment entry of 4 + 'ALBUM=' + 14 chars fills it exactly.
        const ops = { set: { ALBUM: 'abcdefghijklmn' } };
        const plan = planTagWrite(buf, ops);
        expect(plan.inPlace).toBe(true);
        const { file } = buildFile(buf, ops);
        expect(listBlocks(file).blocks.map(b => b.type)).toEqual([0, 4]);
        expect(listBlocks(file).audioOffset).toBe(listBlocks(buf).audioOffset);
    });

    it('falls back to a rewrite when fewer than 4 bytes would be left over', () => {
        const buf = syntheticFlac({ padding: 20 });
        // 24 bytes available; a 22-byte comment entry leaves 2 -> not enough for a PADDING header.
        const plan = planTagWrite(buf, { set: { ALBUM: 'x'.repeat(18 - 6) } });
        expect(plan.inPlace).toBe(false);
        const last = listBlocks(buildFile(buf, { set: { ALBUM: 'x'.repeat(12) } }).file).blocks.pop();
        expect(last.type).toBe(1);
        expect(last.length).toBe(DEFAULT_PADDING);
    });

    it('rewrites with default padding when the tags grow beyond the region', () => {
        const buf = syntheticFlac({ padding: 0 });
        const plan = planTagWrite(buf, { set: { LYRICS: 'la '.repeat(2000) } }, { padding: 512 });
        expect(plan.inPlace).toBe(false);
        const blocks = listBlocks(Buffer.concat([plan.prefix, plan.metadata, Buffer.alloc(0)])).blocks;
        expect(blocks.map(b => b.type)).toEqual([0, 4, 1]);
        expect(blocks[2].length).toBe(512);
    });

    it('shrinking tags keeps the region size (padding grows)', () => {
        const buf = syntheticFlac({ comments: ['TITLE=Song', 'COMMENT=' + 'x'.repeat(500)] });
        const plan = planTagWrite(buf, { remove: ['COMMENT'] });
        expect(plan.inPlace).toBe(true);
        const blocks = listBlocks(buildFile(buf, { remove: ['COMMENT'] }).file).blocks;
        expect(blocks[2].type).toBe(1);
        expect(blocks[2].length).toBe(4 + 'COMMENT='.length + 500 - 4);
    });

    it('preserves the vendor string, other blocks and their order; merges padding to the end', () => {
        const app = Buffer.concat([Buffer.from('CROS'), Buffer.alloc(40, 7)]);
        let buf = syntheticFlac({ vendor: 'vendor XYZ', padding: 30, extra: [{ type: 2, body: app }, { type: 1, body: Buffer.alloc(50) }, { type: 6, body: Buffer.alloc(300, 9) }] });
        const { file, plan } = buildFile(buf, { set: { TITLE: 'New' } });
        expect(plan.vendor).toBe('vendor XYZ');
        const blocks = listBlocks(file).blocks;
        expect(blocks.map(b => b.type)).toEqual([0, 4, 2, 6, 1]);
        expect(file.subarray(blocks[2].bodyStart, blocks[2].bodyStart + blocks[2].length)).toEqual(app);
        expect(readTags(file).vendor).toBe('vendor XYZ');
        expect(plan.inPlace).toBe(true);
        expect(audioOf(file)).toEqual(audioOf(buf));
    });

    it('creates a VORBIS_COMMENT block after STREAMINFO when there is none', () => {
        const buf = withoutVorbisComment(syntheticFlac({ extra: [{ type: 6, body: Buffer.alloc(100, 1) }], padding: 500 }));
        expect(listBlocks(buf).blocks.map(b => b.type)).toEqual([0, 6, 1]);
        const { file, plan } = buildFile(buf, { set: { TITLE: 'Fresh' } });
        expect(plan.vendor).toBe(DEFAULT_VENDOR);
        expect(listBlocks(file).blocks.map(b => b.type)).toEqual([0, 4, 6, 1]);
        expect(readTags(file)).toEqual({ vendor: DEFAULT_VENDOR, tags: { TITLE: ['Fresh'] } });
    });

    it('refuses a file with two VORBIS_COMMENT blocks instead of dropping one', () => {
        const buf = withBlockAfterStreamInfo(syntheticFlac(), 4, vorbisCommentBody('other', ['TITLE=Dup']));
        let err = null;
        try { buildFile(buf, { set: { ARTIST: 'X' } }); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(FlacTagError);
        expect(err.code).toBe('MULTIPLE_COMMENT_BLOCKS');
        expect(err.message).toMatch(/multiple comment blocks/);
        // Reading still works (first block), so the UI can show what is there.
        expect(readTags(buf).tags).toEqual({ TITLE: ['Dup'] });
    });

    it('keeps entries without a "KEY=" part byte for byte, after the editable ones', () => {
        const body = vorbisCommentBody('vend', ['TITLE=a', 'noequals', '=novalue', 'ARTIST=x', 'title=b']);
        const buf = withBlockAfterStreamInfo(withoutVorbisComment(syntheticFlac({ padding: 512 })), 4, body);
        const decoded = parseVorbisComment(body);
        expect(decoded.comments).toEqual([['TITLE', 'a'], ['ARTIST', 'x'], ['title', 'b']]);
        expect(decoded.raw.map(b => b.toString('latin1'))).toEqual(['noequals', '=novalue']);
        const { file, plan } = buildFile(buf, { set: { artist: 'y' } });
        expect(plan.inPlace).toBe(true);
        expect(readTags(file).tags).toEqual({ TITLE: ['a', 'b'], ARTIST: ['y'] });
        const vc = listBlocks(file).blocks.find(b => b.type === 4);
        const back = parseVorbisComment(file.subarray(vc.bodyStart, vc.bodyStart + vc.length));
        expect(back.raw.map(b => b.toString('latin1'))).toEqual(['noequals', '=novalue']);
        expect(back.comments).toEqual([['TITLE', 'a'], ['TITLE', 'b'], ['ARTIST', 'y']]);
        // A no-op edit on such a file still round-trips the raw entries.
        const again = buildFile(file, {});
        expect(again.plan.metadata).toEqual(file.subarray(4, listBlocks(file).audioOffset));
    });

    it('keeps an ID3v2 prefix verbatim', () => {
        const buf = withId3v2(syntheticFlac({ padding: 100 }), 50);
        const { file } = buildFile(buf, { set: { TITLE: 'T' } });
        expect(file.subarray(0, 60)).toEqual(buf.subarray(0, 60));
        expect(readTags(file).tags.TITLE).toEqual(['T']);
    });

    it('round-trips unicode and multi-value tags', () => {
        const buf = syntheticFlac({ padding: 1000 });
        const ops = { set: { TITLE: 'Jóga – Björk 東京 🎵', PERFORMER: ['Violin: Ånna', 'Cello: Bö'], COMMENT: 'a=b=c' } };
        const { file } = buildFile(buf, ops);
        const { tags } = readTags(file);
        expect(tags.TITLE).toEqual(['Jóga – Björk 東京 🎵']);
        expect(tags.PERFORMER).toEqual(['Violin: Ånna', 'Cello: Bö']);
        expect(tags.COMMENT).toEqual(['a=b=c']);
        const vc = listBlocks(file).blocks[1];
        const decoded = parseVorbisComment(file.subarray(vc.bodyStart, vc.bodyStart + vc.length));
        expect(decoded.comments).toContainEqual(['COMMENT', 'a=b=c']);
    });

    it('never alters STREAMINFO or the audio bytes', () => {
        const buf = syntheticFlac();
        const { file } = buildFile(buf, { set: { X: 'y'.repeat(5000) } });
        expect(streamInfoOf(file)).toEqual(streamInfoOf(buf));
        expect(audioOf(file)).toEqual(audioOf(buf));
    });

    it('reports a no-op when nothing changes', () => {
        const buf = syntheticFlac({ padding: 10 });
        const plan = planTagWrite(buf, {});
        expect(plan.metadata).toEqual(buf.subarray(4, listBlocks(buf).audioOffset));
    });
});

describeFfmpeg('writeFlacTags on ffmpeg-encoded files', () => {
    let dir;
    beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-flacwrite-')); });
    afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

    let n = 0;
    const put = async (buf, name = `t${n++}.flac`) => {
        const file = path.join(dir, name);
        await fs.writeFile(file, buf);
        return file;
    };

    const expectIntact = async (file, original) => {
        const now = await fs.readFile(file);
        expect(streamInfoOf(now)).toEqual(streamInfoOf(original));
        expect(sha256(audioOf(now))).toBe(sha256(audioOf(original)));
        expect(decodesCleanly(file)).toBe(true);
    };

    it('uses existing padding (region keeps its size) and keeps the decoded audio identical', async () => {
        const original = withPadding(makeFlac({ tags: { title: 'Orig', artist: 'Band' } }), 4096);
        const file = await put(original);
        const md5Before = decodedMd5(file);
        const result = await writeFlacTags(file, { set: { ALBUM: 'Album', DATE: '2001' }, remove: ['ARTIST'] });
        expect(result.strategy).toBe('rewrite');
        expect(result.changed).toBe(true);
        expect((await fs.stat(file)).size).toBe(original.length);
        expect(listBlocks(await fs.readFile(file)).audioOffset).toBe(listBlocks(original).audioOffset);
        await expectIntact(file, original);
        expect(decodedMd5(file)).toBe(md5Before);
        const tags = ffmpegTags(file);
        expect(tags.album).toBe('Album');
        expect(tags.date).toBe('2001');
        expect(tags.title).toBe('Orig');
        expect(tags.artist).toBeUndefined();
        expect((await readFlacTags(file)).tags).toMatchObject({ TITLE: ['Orig'], ALBUM: ['Album'], DATE: ['2001'] });
    });

    it('rewrites the file when a large addition does not fit, preserving the picture', async () => {
        const original = makeFlac({ tags: { title: 'Pic' }, picture: true });
        expect(listBlocks(original).blocks.some(b => b.type === 6)).toBe(true);
        const file = await put(original);
        const md5Before = decodedMd5(file);
        const lyrics = Array.from({ length: 300 }, (_, i) => `[00:${String(i % 60).padStart(2, '0')}.00] line ${i} ünïcödé`).join('\n');
        const result = await writeFlacTags(file, { set: { LYRICS: lyrics, ARTIST: ['A', 'B'] } });
        expect(result.strategy).toBe('rewrite');
        const now = await fs.readFile(file);
        const blocks = listBlocks(now).blocks;
        expect(blocks.some(b => b.type === 6)).toBe(true);
        expect(blocks[blocks.length - 1]).toMatchObject({ type: 1, length: DEFAULT_PADDING, isLast: true });
        await expectIntact(file, original);
        expect(decodedMd5(file)).toBe(md5Before);
        const { tags } = await readFlacTags(file);
        expect(tags.LYRICS).toEqual([lyrics]);
        expect(tags.ARTIST).toEqual(['A', 'B']);
        expect(tags.TITLE).toEqual(['Pic']);
        expect(await fs.readdir(dir)).not.toContainEqual(expect.stringMatching(/\.tmp$/));
    });

    it('handles zero padding, small padding and large padding', async () => {
        for (const pad of [0, 3, 5, 64, 100000]) {
            const original = pad === 0 ? makeFlac({ tags: { title: `p${pad}` } }) : withPadding(makeFlac({ tags: { title: `p${pad}` } }), pad);
            const file = await put(original);
            const result = await writeFlacTags(file, { set: { GENRE: 'Ambient', COMMENT: 'padding test' } });
            expect(result.strategy).toBe('rewrite');
            if (pad >= 64) expect((await fs.stat(file)).size).toBe(original.length);
            await expectIntact(file, original);
            expect(ffmpegTags(file).genre).toBe('Ambient');
        }
    });

    it('works on stereo 24-bit 96 kHz material', async () => {
        const original = makeFlac({ sampleRate: 96000, channels: 2, sampleFmt: 's32', duration: 0.2, tags: { title: 'Hi' } });
        const file = await put(original);
        const md5Before = decodedMd5(file);
        await writeFlacTags(file, { set: { ALBUM: 'HR' } });
        await expectIntact(file, original);
        expect(decodedMd5(file)).toBe(md5Before);
    });

    it('removal that shrinks the block keeps the region size (padding grows)', async () => {
        // ffmpeg stores "comment" as the Vorbis DESCRIPTION key.
        const original = makeFlac({ tags: { title: 'T', comment: 'x'.repeat(300) } });
        const file = await put(original);
        expect((await readFlacTags(file)).tags.DESCRIPTION).toEqual(['x'.repeat(300)]);
        const result = await writeFlacTags(file, { remove: ['description'] });
        expect(result.strategy).toBe('rewrite');
        expect((await fs.stat(file)).size).toBe(original.length);
        expect(ffmpegTags(file).comment).toBeUndefined();
        expect((await readFlacTags(file)).tags.DESCRIPTION).toBeUndefined();
        await expectIntact(file, original);
    });

    it('keeps the spelling of keys already in the file (ffmpeg writes lowercase)', async () => {
        const original = makeFlac({ tags: { title: 'Lower' } });
        const file = await put(original);
        await writeFlacTags(file, { set: { TITLE: 'Changed', ALBUM: 'New' } });
        const vc = listBlocks(await fs.readFile(file)).blocks.find(b => b.type === 4);
        const now = await fs.readFile(file);
        const { comments } = parseVorbisComment(now.subarray(vc.bodyStart, vc.bodyStart + vc.length));
        expect(comments).toContainEqual(['title', 'Changed']);
        expect(comments).toContainEqual(['ALBUM', 'New']);
    });

    it('reports a no-op without touching the file', async () => {
        const original = makeFlac({ tags: { title: 'Same' } });
        const file = await put(original);
        const before = await fs.stat(file);
        await new Promise(r => setTimeout(r, 20));
        const result = await writeFlacTags(file, { set: { TITLE: 'Same' } });
        expect(result.changed).toBe(false);
        expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
        expect(await fs.readdir(dir)).not.toContainEqual(expect.stringMatching(/\.crossroads-/));
    });

    it('a no-op returns before the audio is hashed', async () => {
        const original = makeFlac({ tags: { title: 'Same' } });
        const file = await put(original);
        const originalOpen = fsp.open;
        let streams = 0;
        fsp.open = async (...args) => {
            const h = await originalOpen(...args);
            const orig = h.createReadStream.bind(h);
            h.createReadStream = (...a) => { streams++; return orig(...a); };
            return h;
        };
        try {
            expect((await writeFlacTags(file, { set: { TITLE: 'Same' } })).changed).toBe(false);
            expect(streams).toBe(0);
            expect((await writeFlacTags(file, { set: { TITLE: 'Other' } })).changed).toBe(true);
            expect(streams).toBe(1);
        } finally {
            fsp.open = originalOpen;
        }
    });

    it('a crash after the temp file is written leaves the original untouched', async () => {
        const original = makeFlac({ tags: { title: 'Crash' } });
        const file = await put(original);
        let tempSeen = null;
        await expect(writeFlacTags(file, { set: { LYRICS: 'z'.repeat(20000) } }, {
            beforeReplace: async (temp) => {
                tempSeen = temp;
                // Simulate the process dying here: copy the temp aside (the writer unlinks it on
                // error) so we can assert it was a complete, valid file, then throw.
                await fs.copyFile(temp, temp + '.kept');
                throw new Error('simulated crash');
            }
        })).rejects.toThrow('simulated crash');
        expect(tempSeen).toMatch(/\.crossroads-\d+-[0-9a-f]+\.tmp$/);
        expect(path.dirname(tempSeen)).toBe(await fs.realpath(path.dirname(file)));   // same directory (tmpdir is a symlink on macOS)
        expect(await fs.readFile(file)).toEqual(original);           // byte-identical original
        expect(fss.existsSync(tempSeen)).toBe(false);                // no temp left behind
        expect(decodesCleanly(tempSeen + '.kept')).toBe(true);       // the temp was complete
        // A stale temp file from an earlier crash never replaces the original either.
        const stale = path.join(dir, `.${path.basename(file)}.crossroads-1-deadbeef.tmp`);
        await fs.writeFile(stale, 'garbage');
        const result = await writeFlacTags(file, { set: { ALBUM: 'After crash' } });
        expect(result.changed).toBe(true);
        expect(await fs.readFile(stale, 'utf8')).toBe('garbage');
        await expectIntact(file, original);
    });

    it('refuses to write to files that are not FLAC', async () => {
        const file = await put(Buffer.from('RIFF\0\0\0\0WAVEfmt '), 'not.flac');
        await expect(writeFlacTags(file, { set: { TITLE: 'x' } })).rejects.toThrow(/Not a FLAC/);
        expect(await fs.readFile(file, 'latin1')).toBe('RIFF\0\0\0\0WAVEfmt ');
    });

    it('refuses a file with two comment blocks and leaves it alone', async () => {
        const original = withBlockAfterStreamInfo(makeFlac({ tags: { title: 'Main' } }), 4, vorbisCommentBody('other', ['TITLE=Dup']));
        const file = await put(original);
        await expect(writeFlacTags(file, { set: { ARTIST: 'x' } })).rejects.toThrow(/multiple comment blocks/);
        expect(await fs.readFile(file)).toEqual(original);
    });

    it('hashAudio hashes the bytes after the metadata', async () => {
        const original = makeFlac();
        const file = await put(original);
        const { audioOffset } = listBlocks(original);
        expect(await hashAudio(file, audioOffset)).toBe(sha256(original.subarray(audioOffset)));
    });
});

describeFfmpeg('writeFlacTags safety', () => {
    let dir;
    beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-flacsafe-')); });
    afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

    let n = 0;
    const put = async (buf, name = `s${n++}.flac`) => {
        const file = path.join(dir, name);
        await fs.writeFile(file, buf);
        return file;
    };
    const temps = () => fss.readdirSync(dir).filter(x => x.includes('.crossroads-'));
    const cleanTemps = () => { for (const t of temps()) fss.unlinkSync(path.join(dir, t)); };

    const HANDLE_METHODS = ['write', 'sync', 'close', 'chmod', 'chown', 'truncate', 'read', 'stat'];
    const TOP_METHODS = ['open', 'rename', 'stat', 'realpath'];

    /** Makes the `failAt`-th call of `method` (on fsp, or on every handle fsp.open returns) throw EIO. */
    function inject(where, method, failAt) {
        const saved = { open: fsp.open, [method]: fsp[method] };
        let calls = 0;
        const state = { fired: false, restore: () => { fsp.open = saved.open; fsp[method] = saved[method]; } };
        const boom = () => { state.fired = true; throw Object.assign(new Error(`simulated ${where}.${method} failure #${failAt}`), { code: 'EIO' }); };
        if (where === 'fsp') {
            const orig = saved[method];
            fsp[method] = async (...a) => { if (calls++ === failAt) boom(); return orig(...a); };
        } else {
            fsp.open = async (...args) => {
                const h = await saved.open(...args);
                const orig = h[method].bind(h);
                h[method] = async (...a) => { if (calls++ === failAt) boom(); return orig(...a); };
                return h;
            };
        }
        return state;
    }

    const scenarios = [
        { name: 'same-size region', ops: { set: { TITLE: 'B' } }, mk: () => withPadding(makeFlac({ tags: { title: 'A' } }), 256) },
        { name: 'growing region', ops: { set: { LYRICS: 'x'.repeat(20000) } }, mk: () => makeFlac({ tags: { title: 'A' } }) }
    ];

    for (const sc of scenarios) {
        for (const [where, methods] of [['handle', HANDLE_METHODS], ['fsp', TOP_METHODS]]) {
            for (const method of methods) {
                it(`crash at every ${where}.${method} call (${sc.name}): original byte-identical, no temp left`, async () => {
                    let fired = 0;
                    for (let failAt = 0; failAt < 40; failAt++) {
                        const original = sc.mk();
                        const file = await put(original);
                        const state = inject(where, method, failAt);
                        let err = null;
                        let result = null;
                        try { result = await writeFlacTags(file, sc.ops); } catch (e) { err = e; }
                        state.restore();
                        if (!state.fired) break;
                        fired++;
                        const after = await fs.readFile(file);
                        expect(temps(), `${method}#${failAt} left a temp`).toEqual([]);
                        if (err && err.code === 'REREAD_FAILED') {
                            // The rename had landed; only the final re-read hit the injected error.
                            expect(err.message).toMatch(/verified before it went in/);
                            expect(decodesCleanly(file)).toBe(true);
                            expect(readTags(after).tags).toMatchObject(sc.ops.set.TITLE ? { TITLE: ['B'] } : { TITLE: ['A'] });
                        } else if (err) {
                            expect(after.equals(original), `${method}#${failAt}: ${err.message}`).toBe(true);
                            expect(err.message).not.toMatch(/restored/i);
                        } else {
                            // The only swallowed failures are the best-effort directory fsync ones.
                            expect(result.changed).toBe(true);
                            expect(decodesCleanly(file)).toBe(true);
                            expect(readTags(after).tags).toMatchObject(sc.ops.set.TITLE ? { TITLE: ['B'] } : { TITLE: ['A'] });
                        }
                        await fs.unlink(file);
                    }
                    expect(fired).toBeGreaterThan(0);
                });
            }
        }
    }

    it('a write that returns short byte counts is completed, never left partial', async () => {
        const original = makeFlac({ tags: { title: 'A' } });
        const file = await put(original);
        const originalOpen = fsp.open;
        fsp.open = async (...args) => {
            const h = await originalOpen(...args);
            const orig = h.write.bind(h);
            h.write = async (buf, off, len, pos) => orig(buf, off, Math.max(1, Math.floor(len / 2)), pos);
            return h;
        };
        try {
            const r = await writeFlacTags(file, { set: { LYRICS: 'y'.repeat(5000) } });
            expect(r.changed).toBe(true);
        } finally {
            fsp.open = originalOpen;
        }
        expect(decodesCleanly(file)).toBe(true);
        expect((await readFlacTags(file)).tags.LYRICS).toEqual(['y'.repeat(5000)]);
        expect(temps()).toEqual([]);
    });

    it('aborts when the original changed underneath (size, mtime or inode) and keeps the other version', async () => {
        const other = withPadding(makeFlac({ tags: { title: 'OTHER', album: 'Other album' } }), 4096);
        // 1. atomic replace by another tool (different size)
        let file = await put(withPadding(makeFlac({ tags: { title: 'A' } }), 256));
        let err = null;
        try {
            await writeFlacTags(file, { set: { TITLE: 'B' } }, { beforeReplace: async () => { await fs.writeFile(file + '.o', other); await fs.rename(file + '.o', file); } });
        } catch (e) { err = e; }
        expect(err?.code).toBe('CHANGED_UNDERNEATH');
        expect(err.message).not.toMatch(/restored/i);
        expect(await fs.readFile(file)).toEqual(other);
        expect(temps()).toEqual([]);
        // 2. same size, only the mtime moved (edited in place by another tool)
        const base = withPadding(makeFlac({ tags: { title: 'A' } }), 256);
        file = await put(base);
        err = null;
        try {
            await writeFlacTags(file, { set: { TITLE: 'B' } }, { beforeReplace: async () => { const t = new Date(Date.now() + 5000); await fs.utimes(file, t, t); } });
        } catch (e) { err = e; }
        expect(err?.code).toBe('CHANGED_UNDERNEATH');
        expect(await fs.readFile(file)).toEqual(base);
        expect(temps()).toEqual([]);
    });

    it('preserves the mode bits exactly, whatever the umask', async () => {
        for (const mode of [0o664, 0o600, 0o755]) {
            const original = makeFlac({ tags: { title: 'A' } });
            const file = await put(original);
            await fs.chmod(file, mode);
            const oldUmask = process.umask(0o022);
            try {
                await writeFlacTags(file, { set: { LYRICS: 'x'.repeat(20000) } });
            } finally {
                process.umask(oldUmask);
            }
            const st = await fs.stat(file);
            expect((st.mode & 0o777).toString(8)).toBe(mode.toString(8));
            expect(temps()).toEqual([]);
        }
    });

    it('refuses files with hard links and leaves both names intact', async () => {
        const original = makeFlac({ tags: { title: 'A' } });
        const file = await put(original);
        const hard = path.join(dir, 'hard.flac');
        await fs.link(file, hard);
        let err = null;
        try { await writeFlacTags(file, { set: { TITLE: 'B' } }); } catch (e) { err = e; }
        expect(err?.code).toBe('HARD_LINKS');
        expect(err.message).toMatch(/hard links/);
        expect(await fs.readFile(file)).toEqual(original);
        expect(await fs.readFile(hard)).toEqual(original);
        expect((await fs.stat(file)).nlink).toBe(2);
        expect(temps()).toEqual([]);
        await fs.unlink(hard);
        expect((await writeFlacTags(file, { set: { TITLE: 'B' } })).changed).toBe(true);
    });

    it('refuses a read-only file instead of replacing it through the directory', async () => {
        const original = makeFlac({ tags: { title: 'A' } });
        const file = await put(original);
        await fs.chmod(file, 0o444);
        let err = null;
        try { await writeFlacTags(file, { set: { TITLE: 'B' } }); } catch (e) { err = e; }
        await fs.chmod(file, 0o644);
        if (process.getuid && process.getuid() === 0) return;   // root can write anything
        expect(err?.code).toBe('READ_ONLY');
        expect(await fs.readFile(file)).toEqual(original);
        expect(temps()).toEqual([]);
    });

    it('writes through a symlink: the real file is replaced and the link stays a link', async () => {
        const original = makeFlac({ tags: { title: 'A' } });
        const real = await put(original, 'real.flac');
        const link = path.join(dir, 'link.flac');
        await fs.symlink(real, link);
        await writeFlacTags(link, { set: { LYRICS: 'x'.repeat(20000) } });
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
        expect((await readFlacTags(real)).tags.LYRICS).toEqual(['x'.repeat(20000)]);
        expect(decodesCleanly(real)).toBe(true);
        expect(temps()).toEqual([]);
    });

    it('bumps the mtime so caches notice the change', async () => {
        const file = await put(makeFlac({ tags: { title: 'A' } }));
        const old = new Date(Date.now() - 60000);
        await fs.utimes(file, old, old);
        await writeFlacTags(file, { set: { TITLE: 'B' } });
        expect((await fs.stat(file)).mtimeMs).toBeGreaterThan(old.getTime() + 1000);
    });

    const hasXattr = process.platform === 'darwin' && !spawnSync('xattr', ['-h'], { stdio: 'ignore' }).error;
    (hasXattr ? it : it.skip)('preserves extended attributes on macOS (APFS clone)', async () => {
        const file = await put(makeFlac({ tags: { title: 'A' } }));
        execFileSync('xattr', ['-w', 'com.crossroads.test', 'kept', file]);
        await writeFlacTags(file, { set: { LYRICS: 'x'.repeat(20000) } });
        expect(execFileSync('xattr', ['-p', 'com.crossroads.test', file], { encoding: 'utf8' }).trim()).toBe('kept');
        expect((await readFlacTags(file)).tags.LYRICS).toEqual(['x'.repeat(20000)]);
        expect(decodesCleanly(file)).toBe(true);
    });

    it('still works when the clone-based temp creation is unavailable', async () => {
        const original = makeFlac({ tags: { title: 'A' } });
        const file = await put(original);
        await fs.chmod(file, 0o640);
        // First open after the clone is the temp 'r+': failing it exercises the plain-create fallback.
        const saved = fsp.open;
        let opens = 0;
        fsp.open = async (p, flags, ...rest) => {
            if (flags === 'r+' && opens++ === 0) throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
            return saved(p, flags, ...rest);
        };
        try {
            const oldUmask = process.umask(0o022);
            try { await writeFlacTags(file, { set: { TITLE: 'B' } }); } finally { process.umask(oldUmask); }
        } finally {
            fsp.open = saved;
        }
        expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
        expect((await readFlacTags(file)).tags.TITLE).toEqual(['B']);
        expect(decodesCleanly(file)).toBe(true);
        expect(temps()).toEqual([]);
    });

    afterAll(cleanTemps);
});

describe('renameWithRetry', () => {
    const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

    it('retries with backoff on Windows while the file is held, then succeeds', async () => {
        const sleeps = [];
        let calls = 0;
        const rename = async () => { if (calls++ < 2) throw eperm(); };
        const attempts = await renameWithRetry('a', 'b', { platform: 'win32', sleep: async (ms) => { sleeps.push(ms); }, rename });
        expect(attempts).toBe(2);
        expect(sleeps).toEqual([50, 100]);
    });

    it('gives up with FILE_IN_USE after the retries', async () => {
        const sleeps = [];
        let err = null;
        try { await renameWithRetry('a', 'b', { platform: 'win32', sleep: async (ms) => { sleeps.push(ms); }, rename: async () => { throw eperm(); } }); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(FlacTagError);
        expect(err.code).toBe('FILE_IN_USE');
        expect(err.message).toMatch(/in use by another program/);
        expect(sleeps).toEqual([50, 100, 200, 400, 800]);
    });

    it('does not retry other errors, nor anything on POSIX', async () => {
        let calls = 0;
        const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        await expect(renameWithRetry('a', 'b', { platform: 'win32', sleep: async () => {}, rename: async () => { calls++; throw enoent; } })).rejects.toBe(enoent);
        expect(calls).toBe(1);
        calls = 0;
        await expect(renameWithRetry('a', 'b', { platform: 'linux', sleep: async () => {}, rename: async () => { calls++; throw eperm(); } })).rejects.toMatchObject({ code: 'EPERM' });
        expect(calls).toBe(1);
    });
});
