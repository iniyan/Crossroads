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
| `playHistory.js` | Play-history entries `{ path, timestamp, trackKey, listened }`, `appendPlay` (records `path` always, `trackKey` only once the song is no longer `provisional`), `setListened`, `backfillTrackKeys` (fills keys by path after a rescan), and the `ListenTimer` used by `App.jsx`. |
| `wrapped.js` | Crossroads Wrapped (#27): `periodOf` / `shiftPeriod` / `availablePeriods` (ISO week Mon–Sun, month, year; local-time boundaries built with `new Date(y, m, d)` so DST never shifts them) and `computeWrapped({ stats, songs, period })`: listening seconds (`listened`, falling back to the song duration for legacy entries and flagging `estimated`), hours per quality tier, top tracks/albums/artists/composers by plays and by time, first-ever plays (`discoveries`, aware of `archivedCounts`), longest daily streak, by-hour/by-weekday and most-played format. Entries are matched by `trackKey`, then `path`; songs missing from the library still count. |

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
