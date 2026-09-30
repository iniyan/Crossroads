// Real FLAC fixtures for the tag-writer tests, produced by ffmpeg (tiny: 0.3 s of a sine at
// 8 kHz mono is about 2 KB). Everything here is test-side: the padding / ID3 helpers build
// the byte layouts independently of the writer under test.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FFMPEG = process.env.FFMPEG || 'ffmpeg';

let ffmpegChecked = null;
export function hasFfmpeg() {
    if (ffmpegChecked === null) {
        const r = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' });
        ffmpegChecked = !r.error && r.status === 0;
    }
    return ffmpegChecked;
}

let scratch = null;
function scratchDir() {
    if (!scratch) scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-flac-fixtures-'));
    return scratch;
}

let counter = 0;
let pngPath = null;
/** A tiny PNG (8x8 solid colour) for PICTURE blocks. */
export function tinyPng() {
    if (!pngPath) {
        pngPath = path.join(scratchDir(), 'cover.png');
        execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=8x8', '-frames:v', '1', pngPath]);
    }
    return fs.readFileSync(pngPath);
}

/**
 * Encodes a FLAC with ffmpeg.
 * @param {Object} [opts]
 * @param {number} [opts.duration=0.3]       seconds
 * @param {number} [opts.sampleRate=8000]
 * @param {number} [opts.channels=1]
 * @param {Object} [opts.tags]               key -> value (ffmpeg -metadata; single values only)
 * @param {boolean} [opts.picture=false]     embed tinyPng() as a PICTURE block
 * @param {string} [opts.sampleFmt='s16']
 * @returns {Buffer}
 */
export function makeFlac({ duration = 0.3, sampleRate = 8000, channels = 1, tags = {}, picture = false, sampleFmt = 's16' } = {}) {
    const out = path.join(scratchDir(), `fixture-${process.pid}-${counter++}.flac`);
    const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`];
    if (picture) args.push('-i', path.join(scratchDir(), (tinyPng(), 'cover.png')));
    args.push('-map', '0:a');
    if (picture) args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
    args.push('-ar', String(sampleRate), '-ac', String(channels), '-sample_fmt', sampleFmt, '-c:a', 'flac');
    for (const [k, v] of Object.entries(tags)) args.push('-metadata', `${k}=${v}`);
    args.push('-f', 'flac', out);
    execFileSync(FFMPEG, args);
    const buf = fs.readFileSync(out);
    fs.unlinkSync(out);
    return buf;
}

// --- byte-level helpers (independent of the writer) --------------------------------------------

function id3Len(buf) {
    if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
    const size = ((buf[6] & 0x7F) << 21) | ((buf[7] & 0x7F) << 14) | ((buf[8] & 0x7F) << 7) | (buf[9] & 0x7F);
    return 10 + size + ((buf[5] & 0x10) ? 10 : 0);
}

/** Lists the metadata blocks of a FLAC buffer: [{ type, isLast, start (header), bodyStart, length }] and the audio offset. */
export function listBlocks(buf) {
    let pos = id3Len(buf);
    if (buf.toString('latin1', pos, pos + 4) !== 'fLaC') throw new Error('not flac');
    pos += 4;
    const blocks = [];
    for (;;) {
        const isLast = (buf[pos] & 0x80) !== 0;
        const type = buf[pos] & 0x7F;
        const length = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
        blocks.push({ type, isLast, start: pos, bodyStart: pos + 4, length });
        pos += 4 + length;
        if (isLast) break;
    }
    return { blocks, audioOffset: pos };
}

function header(type, length, isLast) {
    return Buffer.from([(isLast ? 0x80 : 0) | type, (length >> 16) & 0xFF, (length >> 8) & 0xFF, length & 0xFF]);
}

/** Appends a PADDING block of `n` bytes after the last metadata block. */
export function withPadding(buf, n) {
    const { blocks, audioOffset } = listBlocks(buf);
    const last = blocks[blocks.length - 1];
    const out = Buffer.from(buf);
    out[last.start] &= 0x7F;             // no longer last
    return Buffer.concat([out.subarray(0, audioOffset), header(1, n, true), Buffer.alloc(n, 0), out.subarray(audioOffset)]);
}

/** Inserts a block of `type` with `body` right after STREAMINFO (used for APPLICATION / second VORBIS_COMMENT tests). */
export function withBlockAfterStreamInfo(buf, type, body) {
    const { blocks } = listBlocks(buf);
    const si = blocks[0];
    const end = si.bodyStart + si.length;
    return Buffer.concat([buf.subarray(0, end), header(type, body.length, false), body, buf.subarray(end)]);
}

/** Removes every VORBIS_COMMENT block. */
export function withoutVorbisComment(buf) {
    const { blocks, audioOffset } = listBlocks(buf);
    const kept = blocks.filter(b => b.type !== 4);
    const parts = [buf.subarray(0, blocks[0].start)];
    kept.forEach((b, i) => {
        parts.push(header(b.type, b.length, i === kept.length - 1), buf.subarray(b.bodyStart, b.bodyStart + b.length));
    });
    parts.push(buf.subarray(audioOffset));
    return Buffer.concat(parts);
}

/** Prepends a dummy ID3v2.4 tag of `payload` bytes. */
export function withId3v2(buf, payload = 64) {
    const head = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, (payload >> 21) & 0x7F, (payload >> 14) & 0x7F, (payload >> 7) & 0x7F, payload & 0x7F]);
    return Buffer.concat([head, Buffer.alloc(payload, 0x11), buf]);
}

/** Builds a VORBIS_COMMENT body from a vendor and "KEY=value" strings (test-side encoder). */
export function vorbisCommentBody(vendor, comments) {
    const v = Buffer.from(vendor, 'utf8');
    const parts = [Buffer.alloc(4), v, Buffer.alloc(4)];
    parts[0].writeUInt32LE(v.length, 0);
    parts[2].writeUInt32LE(comments.length, 0);
    for (const c of comments) {
        const b = Buffer.from(c, 'utf8');
        const len = Buffer.alloc(4);
        len.writeUInt32LE(b.length, 0);
        parts.push(len, b);
    }
    return Buffer.concat(parts);
}

/** MD5 of the decoded PCM as ffmpeg computes it ("MD5=<hex>"). */
export function decodedMd5(file) {
    const out = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'md5', '-'], { encoding: 'utf8' });
    return out.trim().replace(/^MD5=/, '');
}

/** True when ffmpeg decodes the file without a single error line. */
export function decodesCleanly(file) {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
    return r.status === 0 && !(r.stderr || '').trim();
}

/** Tags as ffprobe / ffmpeg report them (lowercased keys) via -f ffmetadata. */
export function ffmpegTags(file) {
    const out = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'ffmetadata', '-'], { encoding: 'utf8' });
    const tags = {};
    for (const line of out.split('\n')) {
        const m = /^([^=;\[]+)=(.*)$/.exec(line);
        if (m) tags[m[1].toLowerCase()] = m[2];
    }
    return tags;
}
