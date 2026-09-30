# Library data model

Shared, platform-independent code for the music library. Every platform scanner
(Android `MediaLibraryPlugin` / Electron `app:scanFolder`) returns *raw* songs;
`PlatformService.scanFolder()` runs them through `normalizeSongs()` so the rest of the app
always sees the full `Song` shape documented in [`song.js`](./song.js).

| Module | Purpose |
| --- | --- |
| `song.js` | `Song` / `Quality` JSDoc typedefs, constants (`LYRICS_TAGS`, `QUALITY_TIERS`). |
| `normalize.js` | `normalizeSong(raw)` / `normalizeSongs(list)`: fills derived fields (folder, track/disc numbers, year, genre, lyrics presence, quality, trackKey) and coerces types (`null`, never `undefined`). |
| `quality.js` | Tier rules and badge labels (`FLAC 24/96`, `ALAC 16/44.1`, `MP3 320`), plus `resolveFormat` / `resolveLossless` for ambiguous containers (M4A → ALAC/AAC, OGG → OPUS). |
| `trackKey.js` | Stable cross-device identity: `mb:<uuid>` from MUSICBRAINZ_TRACKID / RELEASETRACKID, else `meta:<artist>\|<album>\|<disc>\|<track>\|<title>` from `normalizeText()` (NFKD, lowercase, no diacritics/punctuation, no "feat. …" suffix when it is a separate word). No audio property is part of the key. |
| `tags.js` | Helpers for the `tags` map: `firstTag`, `tagValues`, `parseNumberPair('7/12')`, `parseYear`. |
| `lrc.js` | LRC lyrics: `parseLrc` (several timestamps per line, `[offset:]`, ms precision, word tags ignored; only the known metadata keys `ti ar al by offset length re ve au` are metadata, so `[Chorus: x]` is text; `plain` keeps blank lines and section headers), `plainText`, `serializeLrc` (`]` and line breaks are dropped from metadata values), `activeLineIndex`. |
| `lyricsResolver.js` | #22 resolution order: embedded synced → `.lrc` sidecar → embedded unsynced → LRCLIB (only when online lookups are enabled); providers are injected. |
| `m3u.js` | #23: `parseM3u` / `serializeM3u` (`#EXTM3U`, `#EXTINF`, `#CROSSROADS-KEY:<trackKey>`, paths relative to the playlist when inside the music root) and `resolveM3uEntries` (path → relative → track key → artist/title+duration → unique file name; unmatched reported). |
| `tagEdit.js` | #20 editor model: `buildEditModel` (bulk: shared vs. mixed fields), the pure edit state (`createEditState`, `setFieldValues`, `removeField`, `revertField`, `addField`, `fieldState`, `jobsForTracks`) and `operationsFromEdits` → `{ set, remove }`, `previewDiff`. Values are arrays (one input per value; `;` is never a separator). A mixed field left blank is "keep existing"; only the explicit remove action removes it from every track; per-track keys are never added to every track in a bulk edit. Keys the file already carries are edited by their trimmed upper-cased spelling; only new keys must be legal names. Writers apply operations against the file's own comments, never a full replacement. |
| `musicbrainz.js` | #20 lookup: rate-limited (≥1.1 s) queued ws/2 JSON client with 503 backoff, `mapRelease`, `matchTracks` (disc/track number → title, with a status per row; pairing leftovers by order is the `pairLeftoversByOrder` opt-in), `selectRowsToApply` (exact matches, plus opted-in title/length mismatches; never unmatched tracks), `tagsForTrack` (MUSICBRAINZ_* ids, numbering, album/title fields). |
| `playHistory.js` | Play-history entries `{ path, timestamp, trackKey, listened }`, `appendPlay` (records `path` always, `trackKey` only once the song is no longer `provisional`), `setListened`, `backfillTrackKeys` (fills keys by path after a rescan), and the `ListenTimer` used by `App.jsx`. |

## Song fields

```
path, folder, trackKey, fileSize, mtime
title, artist, album, albumArtist, composer, genre, year,
trackNumber, trackTotal, discNumber, discTotal, tags, hasEmbeddedLyrics
duration, format, codec, lossless, bitrate, sampleRate, bitsPerSample,
channels, totalSamples, md5, quality: { tier, label }
picture, rawPicture, provisional
```

* `tags` — every tag in the file as `UPPERCASE_NAME -> string[]`. Vorbis comments are
  taken verbatim; ID3 frames and MP4 atoms are mapped onto Vorbis names (`TPE2`/`aART` →
  `ALBUMARTIST`, `TXXX:MusicBrainz Album Id` → `MUSICBRAINZ_ALBUMID`, `USLT`/`©lyr` →
  `UNSYNCEDLYRICS`, `SYLT` → `SYNCEDLYRICS` as LRC lines, `©wrk` → `WORK`, ...). Classical
  (`WORK`, `MOVEMENTNAME`, `MOVEMENT`, `MOVEMENTTOTAL`, `CONDUCTOR`, `PERFORMER`,
  `ENSEMBLE`), lyrics (`LYRICS`, `UNSYNCEDLYRICS`), `REPLAYGAIN_*` and `MUSICBRAINZ_*`
  are therefore all available under the same names on both platforms.
* `quality.tier` — `hires` (lossless and ≥24-bit or ≥88.2 kHz), `cd` (other lossless with
  known properties), `lossy`, `unknown`. `quality.label` is the badge text.
* `md5` — FLAC STREAMINFO signature (hex) when the encoder wrote one; `null` otherwise.
* `tags` never carries lyrics text in the bulk scan result: `LYRICS`, `UNSYNCEDLYRICS` and
  `SYNCEDLYRICS` (and language-suffixed variants) are stripped by the platform and
  `hasEmbeddedLyrics` says they exist. `PlatformService.getTrackDetails(path)` returns the
  full `Song` for one file, lyrics included (Electron `app:getTrackDetails`, restricted to the
  music root; Android `MediaLibrary.getTrackDetails`).
* `picture` — a URL the `<img>` tag can load: `content://media/external/audio/albumart/<id>`
  on Android, `crossroads-media://art/<encoded path>?v=<size>-<mtime>` on desktop (embedded
  picture served on demand, so large libraries do not carry base64 blobs; the query string
  changes with the file so cached covers never go stale). `rawPicture` keeps the original
  `content://` URI on Android for the OS media session.
* `provisional` — true for Android rows whose file has not been probed yet (MediaStore data
  only). The key may still change, quality is unknown; `App.jsx` re-reads the library when
  `PlatformService.onLibraryIndexed` fires and refreshes the queue by path.

## Caches

Both caches are keyed by path and validated by file size + mtime. `PlatformService` passes
`LIBRARY_MODEL_VERSION` (song.js) with every scan; a cache written under another model
version is dropped. Deterministic parse failures are cached (with a retry after 7 days) so a
broken file is not re-parsed on every launch; transient I/O errors are not cached. Pruning
of entries for deleted files is skipped when the live file set is empty (a transient empty
listing must not wipe the cache).

* Desktop: `userData/library-index.json` (`electron/libraryIndex.js`), versioned as
  `<INDEX_VERSION>.<LIBRARY_MODEL_VERSION>`. One scan or details read at a time.
* Android: `library-index.db` (SQLite, `LibraryIndexDb.java`, one shared WAL connection per
  process) with the per-file probe JSON, the `PROBE_VERSION` it was produced with (older rows
  are re-probed) and the model version in a meta row. `getTracks({ budgetMs, modelVersion })`
  runs on the plugin's own thread, loads the whole cache in one query, probes for `budgetMs`
  (1.5 s by default, so MediaStore rows appear at once), returns with the rest flagged
  `provisional`, and finishes them on a background thread. That pass fires the
  `libraryIndexed` event on whichever plugin instance is alive at the time
  (`PlatformService.onLibraryIndexed`), and the app rescans.

## Tag writing (#20)

FLAC only in v1; every other format is read-only in the editor. The writer lives in
`electron/flacTagWriter.js` (desktop, via IPC `app:writeTags` restricted to the music root)
and `android/.../FlacTagWriter.java` + `SafTagWriter.java` (Android, through a Storage Access
Framework folder grant from the `MediaFiles` plugin). Both produce byte-identical files for the
same edit, pinned by `android/app/src/test/resources/flac-vectors.txt`
(`node scripts/generateFlacVectors.mjs` regenerates it with ffmpeg). Rules: replace only the
VORBIS_COMMENT block (reusing PADDING when the new block fits so the audio offset does not
move); every other block, the vendor string and entries without a `KEY=` part are preserved;
a file with more than one comment block is refused. The file is always written to a temp file
next to the original, verified (STREAMINFO bytes with MD5, SHA-256 of the audio region, tags
read back) and only then renamed over the original.
