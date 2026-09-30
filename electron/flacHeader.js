// Minimal FLAC metadata-block walker. music-metadata gives us tags, sample rate and bit
// depth but neither the STREAMINFO MD5 signature nor the total sample count, and both
// matter to the app (tag-write verification in #20, fake-hi-res result caching in #28).
// Only block headers and STREAMINFO are read; every other block is skipped by seeking.

const fsp = require('fs/promises');

const BLOCK_STREAMINFO = 0;
const BLOCK_PICTURE = 6;
const STREAMINFO_LENGTH = 34;
const MAX_BLOCKS = 128;

function parseStreamInfo(buf) {
    // Layout (bits): 16 minBlock, 16 maxBlock, 24 minFrame, 24 maxFrame, 20 sampleRate,
    // 3 channels-1, 5 bps-1, 36 totalSamples, 128 md5.
    const sampleRate = (buf.readUInt32BE(10) >>> 12) & 0xFFFFF;
    const channels = ((buf[12] >> 1) & 0x07) + 1;
    const bitsPerSample = (((buf[12] & 0x01) << 4) | (buf[13] >> 4)) + 1;
    const totalSamples = (buf[13] & 0x0F) * 2 ** 32 + buf.readUInt32BE(14);
    const md5Bytes = buf.subarray(18, 34);
    const md5 = md5Bytes.every(b => b === 0) ? null : md5Bytes.toString('hex');
    return { sampleRate, channels, bitsPerSample, totalSamples, md5 };
}

/** Byte length of an ID3v2 tag at the start of `buf` (some FLACs carry one), or 0. */
function id3v2Length(buf) {
    if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
    const size = ((buf[6] & 0x7F) << 21) | ((buf[7] & 0x7F) << 14) | ((buf[8] & 0x7F) << 7) | (buf[9] & 0x7F);
    const footer = (buf[5] & 0x10) ? 10 : 0;
    return 10 + size + footer;
}

/**
 * @param {string} filePath
 * @returns {Promise<{sampleRate:number, channels:number, bitsPerSample:number, totalSamples:number,
 *           md5:string|null, hasPicture:boolean, blocks:number} | null>}  null when not a FLAC stream.
 */
async function readFlacStreamInfo(filePath) {
    const handle = await fsp.open(filePath, 'r');
    try {
        const head = Buffer.alloc(10);
        let position = 0;
        let { bytesRead } = await handle.read(head, 0, 10, position);
        if (bytesRead < 4) return null;
        position += id3v2Length(head);
        if (position > 0) {
            ({ bytesRead } = await handle.read(head, 0, 4, position));
            if (bytesRead < 4) return null;
        }
        if (head.toString('latin1', 0, 4) !== 'fLaC') return null;
        position += 4;

        let info = null;
        let hasPicture = false;
        let blocks = 0;
        const header = Buffer.alloc(4);
        for (;;) {
            if (blocks++ >= MAX_BLOCKS) break;
            ({ bytesRead } = await handle.read(header, 0, 4, position));
            if (bytesRead < 4) break;
            position += 4;
            const isLast = (header[0] & 0x80) !== 0;
            const type = header[0] & 0x7F;
            const length = (header[1] << 16) | (header[2] << 8) | header[3];

            if (type === BLOCK_STREAMINFO && length === STREAMINFO_LENGTH && !info) {
                const body = Buffer.alloc(STREAMINFO_LENGTH);
                ({ bytesRead } = await handle.read(body, 0, STREAMINFO_LENGTH, position));
                if (bytesRead < STREAMINFO_LENGTH) break;
                info = parseStreamInfo(body);
            } else if (type === BLOCK_PICTURE) {
                hasPicture = true;
            }
            position += length;
            if (isLast) break;
        }
        return info ? { ...info, hasPicture, blocks } : null;
    } finally {
        await handle.close();
    }
}

module.exports = { readFlacStreamInfo, parseStreamInfo, id3v2Length };
