// Flattens music-metadata's `metadata.native` (per tag type: vorbis, ID3v2.x, iTunes,
// exif/INFO, APEv2) into the app's `tags` map: UPPERCASE Vorbis-comment style names,
// every value an array of strings. Pictures are dropped (only their presence matters).

// ID3v2.3/2.4 frame -> Vorbis name.
const ID3_FRAMES = {
    TIT2: 'TITLE', TPE1: 'ARTIST', TALB: 'ALBUM', TPE2: 'ALBUMARTIST', TCOM: 'COMPOSER',
    TCON: 'GENRE', TRCK: 'TRACKNUMBER', TPOS: 'DISCNUMBER', TYER: 'DATE', TDRC: 'DATE',
    TDRL: 'RELEASEDATE', TDOR: 'ORIGINALDATE', TORY: 'ORIGINALDATE', TIT1: 'GROUPING',
    TIT3: 'SUBTITLE', TPE3: 'CONDUCTOR', TPE4: 'REMIXER', TEXT: 'LYRICIST', TPUB: 'LABEL',
    TSRC: 'ISRC', TBPM: 'BPM', TSST: 'DISCSUBTITLE', TSOA: 'ALBUMSORT', TSOP: 'ARTISTSORT',
    TSOT: 'TITLESORT', TSO2: 'ALBUMARTISTSORT', TSOC: 'COMPOSERSORT', TCOP: 'COPYRIGHT',
    TENC: 'ENCODEDBY', TSSE: 'ENCODER', TLAN: 'LANGUAGE', TMOO: 'MOOD', TMED: 'MEDIA',
    TOPE: 'ORIGINALARTIST', TOAL: 'ORIGINALALBUM', TOLY: 'ORIGINALLYRICIST', TCMP: 'COMPILATION',
    TKEY: 'INITIALKEY', TLEN: 'LENGTH', TDTG: 'TAGGINGDATE', TOWN: 'FILEOWNER', TRSN: 'RADIOSTATION',
    TRSO: 'RADIOSTATIONOWNER', TOFN: 'ORIGINALFILENAME', TDLY: 'PLAYLISTDELAY', TFLT: 'FILETYPE',
    TPRO: 'PRODUCEDNOTICE', TDEN: 'ENCODINGTIME', TIPL: 'INVOLVEDPEOPLE', IPLS: 'INVOLVEDPEOPLE',
    TMCL: 'MUSICIANCREDITS', MVNM: 'MOVEMENTNAME', MVIN: 'MOVEMENT', GRP1: 'GROUPING',
    USLT: 'UNSYNCEDLYRICS', SYLT: 'SYNCEDLYRICS', COMM: 'COMMENT', WOAR: 'WEBSITE', WXXX: 'URL',
    WCOP: 'LICENSE', WOAF: 'WOAF', WOAS: 'WOAS', WORS: 'WORS', WPUB: 'WPUB',
    // ID3v2.2 three-letter frames
    TT2: 'TITLE', TP1: 'ARTIST', TAL: 'ALBUM', TP2: 'ALBUMARTIST', TCM: 'COMPOSER', TCO: 'GENRE',
    TRK: 'TRACKNUMBER', TPA: 'DISCNUMBER', TYE: 'DATE', TT1: 'GROUPING', TT3: 'SUBTITLE',
    TP3: 'CONDUCTOR', TP4: 'REMIXER', TXT: 'LYRICIST', TPB: 'LABEL', TRC: 'ISRC', TBP: 'BPM',
    TCR: 'COPYRIGHT', TEN: 'ENCODEDBY', TSS: 'ENCODER', TLA: 'LANGUAGE', TOA: 'ORIGINALARTIST',
    TOT: 'ORIGINALALBUM', TKE: 'INITIALKEY', TLE: 'LENGTH', ULT: 'UNSYNCEDLYRICS', SLT: 'SYNCEDLYRICS',
    COM: 'COMMENT', IPL: 'INVOLVEDPEOPLE'
};

const ID3_SKIP = new Set(['APIC', 'PIC', 'PRIV', 'GEOB', 'MCDI', 'PCNT', 'CNT', 'RVAD', 'RVA2', 'EQUA', 'EQU2',
    'ETCO', 'MLLT', 'SYTC', 'RBUF', 'AENC', 'POSS', 'ENCR', 'GRID', 'SIGN', 'SEEK', 'ASPI', 'TFLT']);

// iTunes / MP4 atoms -> Vorbis name.
const ITUNES_ATOMS = {
    '©nam': 'TITLE', '©ART': 'ARTIST', '©alb': 'ALBUM', 'aART': 'ALBUMARTIST', '©wrt': 'COMPOSER',
    '©gen': 'GENRE', 'gnre': 'GENRE', '©day': 'DATE', 'trkn': 'TRACKNUMBER', 'disk': 'DISCNUMBER',
    '©lyr': 'UNSYNCEDLYRICS', '©cmt': 'COMMENT', '©grp': 'GROUPING', '©wrk': 'WORK', '©mvn': 'MOVEMENTNAME',
    '©mvi': 'MOVEMENT', '©mvc': 'MOVEMENTTOTAL', 'shwm': 'SHOWMOVEMENT', 'cpil': 'COMPILATION',
    'tmpo': 'BPM', '©too': 'ENCODER', 'cprt': 'COPYRIGHT', 'soal': 'ALBUMSORT', 'soar': 'ARTISTSORT',
    'sonm': 'TITLESORT', 'soaa': 'ALBUMARTISTSORT', 'soco': 'COMPOSERSORT', 'pgap': 'GAPLESS',
    'desc': 'DESCRIPTION', 'ldes': 'LONGDESCRIPTION', '©enc': 'ENCODEDBY', 'catg': 'CATEGORY',
    'keyw': 'KEYWORDS', 'purd': 'PURCHASEDATE', 'rtng': 'RATING', 'stik': 'MEDIATYPE', 'hdvd': 'HDVIDEO',
    'tvsh': 'TVSHOW', 'tven': 'TVEPISODEID', 'tves': 'TVEPISODE', 'tvsn': 'TVSEASON', 'apID': 'ACCOUNTID',
    'ownr': 'OWNER', 'xid ': 'XID', 'purl': 'PODCASTURL', 'egid': 'EPISODEGUID', 'pcst': 'PODCAST'
};

const ITUNES_SKIP = new Set(['covr', 'sfID', 'cnID', 'atID', 'plID', 'geID', 'akID', 'cmID', 'flvr']);

// RIFF INFO (WAV / AIFF) chunk ids -> Vorbis name.
const RIFF_INFO = {
    INAM: 'TITLE', IART: 'ARTIST', IPRD: 'ALBUM', ICRD: 'DATE', IGNR: 'GENRE', ICMT: 'COMMENT',
    ITRK: 'TRACKNUMBER', IPRT: 'TRACKNUMBER', ICOP: 'COPYRIGHT', ISFT: 'ENCODER', IENG: 'ENGINEER',
    ICMS: 'COMMISSIONED', IKEY: 'KEYWORDS', ISBJ: 'SUBJECT', ITCH: 'TECHNICIAN', ISRC: 'SOURCE',
    IMED: 'MEDIA', ILNG: 'LANGUAGE', IWRI: 'LYRICIST', IMUS: 'COMPOSER', IPRO: 'PRODUCER'
};

// APEv2 keys are free-form; a few common ones have Vorbis equivalents.
const APE_KEYS = {
    TRACK: 'TRACKNUMBER', DISC: 'DISCNUMBER', YEAR: 'DATE', 'ALBUM ARTIST': 'ALBUMARTIST',
    'MIXARTIST': 'REMIXER', 'RECORD LABEL': 'LABEL', 'CATALOG': 'CATALOGNUMBER'
};

// Free-text descriptions (TXXX / ----:com.apple.iTunes:) that have a canonical Vorbis name.
const DESCRIPTION_NAMES = {
    'MUSICBRAINZ ALBUM ID': 'MUSICBRAINZ_ALBUMID',
    'MUSICBRAINZ RELEASE TRACK ID': 'MUSICBRAINZ_RELEASETRACKID',
    'MUSICBRAINZ TRACK ID': 'MUSICBRAINZ_TRACKID',
    'MUSICBRAINZ ARTIST ID': 'MUSICBRAINZ_ARTISTID',
    'MUSICBRAINZ ALBUM ARTIST ID': 'MUSICBRAINZ_ALBUMARTISTID',
    'MUSICBRAINZ RELEASE GROUP ID': 'MUSICBRAINZ_RELEASEGROUPID',
    'MUSICBRAINZ WORK ID': 'MUSICBRAINZ_WORKID',
    'MUSICBRAINZ ALBUM TYPE': 'RELEASETYPE',
    'MUSICBRAINZ ALBUM STATUS': 'RELEASESTATUS',
    'MUSICBRAINZ ALBUM RELEASE COUNTRY': 'RELEASECOUNTRY',
    'MUSICBRAINZ DISC ID': 'MUSICBRAINZ_DISCID',
    'MUSICBRAINZ TRM ID': 'MUSICBRAINZ_TRMID',
    'ACOUSTID ID': 'ACOUSTID_ID',
    'ACOUSTID FINGERPRINT': 'ACOUSTID_FINGERPRINT',
    'ALBUM ARTIST': 'ALBUMARTIST',
    'ALBUMARTISTSORT': 'ALBUMARTISTSORT',
    'CATALOGNUMBER': 'CATALOGNUMBER',
    'CATALOG NUMBER': 'CATALOGNUMBER',
    'MUSICIP PUID': 'MUSICIP_PUID',
    'REPLAYGAIN_TRACK_GAIN': 'REPLAYGAIN_TRACK_GAIN',
    'REPLAYGAIN_TRACK_PEAK': 'REPLAYGAIN_TRACK_PEAK',
    'REPLAYGAIN_ALBUM_GAIN': 'REPLAYGAIN_ALBUM_GAIN',
    'REPLAYGAIN_ALBUM_PEAK': 'REPLAYGAIN_ALBUM_PEAK',
    'ARTISTS': 'ARTISTS',
    'WORK': 'WORK',
    'MOVEMENTNAME': 'MOVEMENTNAME',
    'MOVEMENT NAME': 'MOVEMENTNAME',
    'MOVEMENT': 'MOVEMENT',
    'MOVEMENTTOTAL': 'MOVEMENTTOTAL',
    'MOVEMENT TOTAL': 'MOVEMENTTOTAL',
    'SHOWMOVEMENT': 'SHOWMOVEMENT',
    'ORIGINALYEAR': 'ORIGINALYEAR',
    'ORIGINAL YEAR': 'ORIGINALYEAR',
    'BARCODE': 'BARCODE',
    'ASIN': 'ASIN',
    'SCRIPT': 'SCRIPT',
    'LABEL': 'LABEL',
    'MEDIA': 'MEDIA',
    'ISRC': 'ISRC',
    'LICENSE': 'LICENSE',
    'PERFORMER': 'PERFORMER',
    'CONDUCTOR': 'CONDUCTOR',
    'ENSEMBLE': 'ENSEMBLE',
    'ORCHESTRA': 'ORCHESTRA',
    'ARRANGER': 'ARRANGER',
    'ENGINEER': 'ENGINEER',
    'PRODUCER': 'PRODUCER',
    'MIXER': 'MIXER',
    'DJMIXER': 'DJMIXER',
    'LYRICIST': 'LYRICIST',
    'WRITER': 'WRITER',
    'COMPOSERSORT': 'COMPOSERSORT',
    'LYRICS': 'LYRICS',
    'UNSYNCEDLYRICS': 'UNSYNCEDLYRICS',
    'SYNCEDLYRICS': 'SYNCEDLYRICS',
    'DISCSUBTITLE': 'DISCSUBTITLE',
    'TOTALTRACKS': 'TOTALTRACKS',
    'TOTALDISCS': 'TOTALDISCS',
    'TRACKTOTAL': 'TRACKTOTAL',
    'DISCTOTAL': 'DISCTOTAL',
    'FBPM': 'BPM',
    'INITIALKEY': 'INITIALKEY',
    'MOOD': 'MOOD',
    'RATING': 'RATING'
};

/** 'MusicBrainz Album Id' -> MUSICBRAINZ_ALBUMID; anything else -> UPPERCASE with underscores. */
function canonicalDescription(description) {
    const key = String(description || '').trim().replace(/_/g, ' ').replace(/\s+/g, ' ').toUpperCase();
    if (!key) return null;
    if (DESCRIPTION_NAMES[key]) return DESCRIPTION_NAMES[key];
    return key.replace(/ /g, '_');
}

function stringValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    return null;
}

function bufferToUtf8(value) {
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    return null;
}

/** Turns a native value into zero or more strings. Structured values are flattened sensibly. */
function valueStrings(value) {
    if (value === null || value === undefined) return [];
    const scalar = stringValue(value);
    if (scalar !== null) return [scalar];
    if (Array.isArray(value)) return value.flatMap(valueStrings);
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return [];
    if (typeof value === 'object') {
        // USLT / COMM: { language, description, text }
        if (typeof value.text === 'string') return [value.text];
        if (Array.isArray(value.text)) return value.text.flatMap(valueStrings);
        // TIPL / TMCL / IPLS: { role: [names] }
        const entries = Object.entries(value);
        if (entries.length > 0 && entries.every(([, v]) => Array.isArray(v) || typeof v === 'string')) {
            return entries.flatMap(([role, names]) => valueStrings(names).map(name => `${role}: ${name}`));
        }
    }
    return [];
}

/** 61230 -> '[01:01.23]', matching the LRC lines the Android reader writes for SYLT. */
function lrcTimestamp(ms) {
    const total = Math.max(0, Math.floor(ms));
    const seconds = Math.floor(total / 1000);
    const minutes = Math.floor(seconds / 60);
    const hundredths = Math.floor((total % 1000) / 10);
    const pad = (n) => String(n).padStart(2, '0');
    return `[${pad(minutes)}:${pad(seconds % 60)}.${pad(hundredths)}]`;
}

/**
 * SYLT -> LRC-style lines. music-metadata exposes the frame either as a plain array of the
 * text pieces (older versions) or as { timeStampFormat, syncText: [{ text, timeStamp }] };
 * timestamps are prefixed only when they are milliseconds (format 2), not MPEG frames (1).
 */
function syncedLyricsLines(value) {
    if (Array.isArray(value) && value.some(v => v && typeof v === 'object' && Array.isArray(v.syncText))) {
        return value.flatMap(syncedLyricsLines);
    }
    if (value && typeof value === 'object' && Array.isArray(value.syncText)) {
        const format = value.timeStampFormat;
        const milliseconds = format === undefined || format === null || format === 2 || /milli/i.test(String(format));
        const lines = [];
        for (const item of value.syncText) {
            if (!item || typeof item !== 'object') continue;
            let text = typeof item.text === 'string' ? item.text : '';
            if (text.startsWith('\n')) text = text.slice(1);
            text = text.replace(/\0+$/, '');
            const stamp = milliseconds && Number.isFinite(item.timeStamp) ? lrcTimestamp(item.timeStamp) : '';
            if (text || stamp) lines.push(stamp + text);
        }
        return lines;
    }
    return valueStrings(value);
}

function add(tags, name, values) {
    if (!name) return;
    const strings = values.map(v => (typeof v === 'string' ? v.replace(/\0+$/, '').trim() : v)).filter(v => v);
    if (strings.length === 0) return;
    tags[name] = tags[name] ? tags[name].concat(strings) : strings;
}

function mapVorbis(tags, id, value) {
    const key = String(id).toUpperCase();
    if (key === 'METADATA_BLOCK_PICTURE' || key === 'COVERART' || key === 'COVERARTMIME') return;
    add(tags, key, valueStrings(value));
}

function mapId3(tags, id, value) {
    const frame = String(id);
    const [frameId, description] = frame.includes(':') ? [frame.slice(0, frame.indexOf(':')), frame.slice(frame.indexOf(':') + 1)] : [frame, null];
    if (ID3_SKIP.has(frameId)) return;

    if (frameId === 'TXXX' || frameId === 'TXX') {
        const desc = description || value?.description;
        add(tags, canonicalDescription(desc), valueStrings(value?.text ?? value));
        return;
    }
    if (frameId === 'UFID' || frameId === 'UFI') {
        const owner = String(value?.owner_identifier || description || '');
        if (/musicbrainz/i.test(owner)) add(tags, 'MUSICBRAINZ_TRACKID', [bufferToUtf8(value?.identifier)].filter(Boolean));
        return;
    }
    if (frameId === 'WXXX' || frameId === 'WXX') {
        add(tags, 'URL', valueStrings(value?.url ?? value?.text ?? value));
        return;
    }
    if (frameId === 'POPM' || frameId === 'POP') {
        if (value && typeof value.rating === 'number') add(tags, 'RATING', [String(value.rating)]);
        return;
    }
    if (frameId === 'SYLT' || frameId === 'SLT') {
        const lines = syncedLyricsLines(value);
        if (lines.length > 0) add(tags, 'SYNCEDLYRICS', [lines.join('\n')]);
        return;
    }
    const name = ID3_FRAMES[frameId] || (frameId.length === 4 ? frameId : null);
    if (!name) return;
    add(tags, name, valueStrings(value));
}

function mapItunes(tags, id, value) {
    const atom = String(id);
    if (ITUNES_SKIP.has(atom)) return;
    if (atom.startsWith('----:')) {
        // '----:com.apple.iTunes:MusicBrainz Track Id'
        const description = atom.slice(atom.lastIndexOf(':') + 1);
        add(tags, canonicalDescription(description), valueStrings(value));
        return;
    }
    const name = ITUNES_ATOMS[atom] || canonicalDescription(atom.replace(/^©/, ''));
    add(tags, name, valueStrings(value));
}

function mapRiffInfo(tags, id, value) {
    const chunk = String(id);
    if (chunk.startsWith('bext.')) {
        add(tags, canonicalDescription('BEXT_' + chunk.slice(5)), valueStrings(value));
        return;
    }
    add(tags, RIFF_INFO[chunk] || canonicalDescription(chunk), valueStrings(value));
}

function mapApe(tags, id, value) {
    const key = String(id).toUpperCase();
    if (key.startsWith('COVER ART')) return;
    add(tags, APE_KEYS[key] || canonicalDescription(key), valueStrings(value));
}

const MAPPERS = [
    { test: t => t === 'vorbis', map: mapVorbis },
    { test: t => t.startsWith('id3v2'), map: mapId3 },
    { test: t => t === 'itunes', map: mapItunes },
    { test: t => t === 'exif', map: mapRiffInfo },
    { test: t => t === 'apev2', map: mapApe },
    { test: t => t === 'asf', map: (tags, id, value) => add(tags, canonicalDescription(String(id).replace(/^WM\//i, '')), valueStrings(value)) }
];

/**
 * @param {Object.<string, Array<{id:string,value:any}>>} native  music-metadata's `metadata.native`.
 * @returns {Object.<string, string[]>}
 */
function flattenNativeTags(native) {
    const tags = {};
    if (!native || typeof native !== 'object') return tags;
    // ID3v1 only when nothing better exists; it is a strict subset with truncated values.
    const types = Object.keys(native).filter(t => t !== 'ID3v1');
    const useV1 = types.length === 0 && Array.isArray(native.ID3v1);
    for (const type of useV1 ? ['ID3v1'] : types) {
        const list = native[type];
        if (!Array.isArray(list)) continue;
        const lower = type.toLowerCase();
        const mapper = MAPPERS.find(m => m.test(lower));
        for (const entry of list) {
            if (!entry || typeof entry.id !== 'string') continue;
            try {
                if (mapper) mapper.map(tags, entry.id, entry.value);
                else if (lower === 'id3v1') add(tags, canonicalDescription(entry.id), valueStrings(entry.value));
                else add(tags, canonicalDescription(entry.id), valueStrings(entry.value));
            } catch {
                // A single malformed frame must not lose the rest of the tags.
            }
        }
    }
    return tags;
}

module.exports = { flattenNativeTags, canonicalDescription, valueStrings, syncedLyricsLines, lrcTimestamp };
