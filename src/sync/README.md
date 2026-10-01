# LAN sync (#25)

Desktop <-> Android sync of favorites, playlists and play history over the local network.
No cloud, no accounts: the desktop hosts an HTTP endpoint while "Sync" is switched on, the
phone finds it with DNS-SD, pairs once, and exchanges encrypted deltas.

| Module | Purpose |
| --- | --- |
| `hlc.js` | Hybrid logical clock `{ w, c, d }` per device; total order for last-writer-wins. |
| `model.js` | Pure data model: capture app state -> synced state, merge, apply back as ops, delta framing (`clientRequest` / `clientReceive` / `serverExchange`), data limits. |
| `crypto.mjs` | WebCrypto only (shared with the Electron main process): pairing math, AES-GCM frames with sequence counters, capped gunzip, discovery tags. |
| `client.js` | Phone side: `pair()`, `exchange()`, `unpair()` over an injected transport. |
| `mirror.js` | The hook's authoritative copy of the app state between React commits. |
| `endpoints.js` | Phone side: which addresses to try for a desktop, and how to word a failure. |
| `names.mjs` | Device-name sanitising shared by server, peer store and phone (controls, bidi / zero-width / format characters stripped, whitespace collapsed, length capped). |
| `useLanSync.js` | React hook used by `App.jsx`: persistence, desktop exchange handler, phone discovery / pairing / sync / auto-sync. |
| `../services/blobStore.js` | IndexedDB key/value store (shared with other features) holding the model store. |
| `../components/SyncView.jsx` | The Sync view (desktop and phone). |
| `../../electron/sync/server.mjs` | Desktop server: pairing state machine, `/v1/sync`, `/v1/unpair`, rate limits, browser rejection. Plain Node, runs headless in `__tests__/e2e.test.js`. |
| `../../electron/sync/peerStore.mjs` | `userData/sync-peers.json` (mode 0600): desktop identity and name, "enabled" flag, per-peer long-term keys and frame counters. |
| `../../electron/sync/advertise.mjs` | `_crossroads._tcp` via `bonjour-service` (MIT); instance name = device name, TXT `{ v, s, h }`. |
| `../../electron/sync/ipc.js` | Glue: IPC handlers, forwards exchanges to the renderer, bounded shutdown. |
| `android/.../SyncDiscoveryPlugin.java` | NSD discovery, LAN HTTP over a raw socket (`LanHttpClient`), Keystore-wrapped secrets, backup-excluded sync record. `LanAddress` is the pure URL/address validator; both are JVM-tested. |

## Data model

Tracks are identified by `trackKey` (see `../library/trackKey.js`); paths never leave a device.

```
favorites: { [trackKey]: { on, t } }                       LWW per track, tombstone = on:false
playlists: { [id]: { name, tracks: [trackKey], t, deleted? } }   LWW per playlist (whole list)
history:   { [`${trackKey}@${ts}`]: { l? } }                union, `l` (listened seconds) = max
```

* **Whole-playlist LWW**: concurrent edits of the same playlist on two devices keep the later
  edit; the other is dropped (the issue asks for per-item LWW with tombstones; a per-track
  merge would need ordering rules that are not worth it for playlists).
* **Capture by diffing**: the rest of the app keeps its plain state; at sync time
  `captureLocal` diffs favorites / playlists / stats against the snapshot taken after the last
  sync, stamps new HLCs on what changed and tombstones what disappeared. Removals only count
  when the track is still in the library, and the keys of every favorite / playlist path are
  remembered, so a deleted or not-yet-indexed file never looks like a removal. Provisional
  Android rows (no final key yet) are ignored until indexed.
* **Apply as ops**: `applyToLocal` returns operations (favorites add/remove, playlist
  upsert/remove, plays) relative to the state it was computed against; the hook applies them
  with functional React updates, so an edit made while a request was in flight survives, and
  the snapshot records what was applied so the next capture sees that edit as a change.
  Between React commits the hook captures from its own mirror of the state (`mirror.js`), so
  back-to-back exchanges never diff against stale props.
* **Unmatched tracks** (key with no song here) stay in the synced state, are reported in the
  UI, and are applied automatically once the library gains the track, including tracks of a
  playlist that otherwise did not change. Unmatched playlist entries keep their position when
  the playlist is edited locally.
* **Play history**: entries without a `trackKey` sync only when their path maps to a key. A
  play is applied to a device's history exactly once (`_a` flag) and the app persists stats on
  the render that applied them, so plays trimmed by `MAX_PLAY_HISTORY` never come back.
  `archivedCounts` is not synced (it is the trim residue of an already-merged history). The
  synced history keeps the newest `MAX_PLAY_HISTORY` entries (`store.horizon`).
* **Deltas**: every item carries a device-local revision `_r`; a peer that acknowledged
  revision N receives items with `_r > N`. First sync = everything. Items a peer sent that won
  the merge are not echoed back; items it sent that lost get a new revision so it learns the
  winner. Frames above 512 bytes are gzipped.
* **Limits** (`LIMITS` in model.js): per exchange 40k items / 16 MB of content; per playlist
  10k tracks; per store 2k playlists, 20k favorites, 50k playlist entries; keys <= 512 chars.
  An over-limit delta is refused as a whole (`SyncLimitError`, 413 on the wire) and merges
  nothing. Maps indexed by peer keys are null-prototype objects and `__proto__`-style keys are
  rejected.
* **Storage**: the model store (synced state, snapshot, clock) lives in IndexedDB
  (`blobStore`, key `sync:store`); only the small record (identity, peers, watermarks,
  auto-sync flag) is in the settings store (desktop: electron-store `sync`; Android: the
  plugin's own `crossroads_sync_state` preferences file).
* Not synced: `totalTime`, theme and other device settings (device-specific).

## Security

* **Pairing** = numeric comparison over ECDH P-256 with a commitment (Bluetooth SSP style),
  confirmed on both screens: the phone commits to a nonce, both exchange public keys and
  nonces, both derive the same 6-digit code from the transcript and show it with the other
  side's name and key fingerprint. The desktop user confirms the phone shows the digits; the
  phone user confirms the computer shows them; key-confirmation proofs run in both
  directions (server proof released only after the desktop confirmed, client proof in
  `/pair/finish`), and the peer is stored on each side only after all of that. The long-term
  key is `HKDF(ECDH secret, transcript)`. Without a PAKE (not expressible with WebCrypto
  primitives) a code typed into the phone can be brute-forced offline by an active attacker
  who intercepts the phone's first message; with comparison there is no secret to brute-force
  and a man-in-the-middle matches both screens with probability 10^-6 per attempt.
* **Pairing window**: opened only by an explicit desktop action, 2 minutes, 5 attempts. One
  session at a time: while a session is being compared / confirmed, `/pair/start` answers
  409 and only the desktop user can reject or cancel it, so the code on screen never changes
  under the user. A session that was only started is held for 10 s (`START_HOLD_MS`) before
  another start may replace it: the phone reveals one round trip after starting, so a LAN
  observer cannot slip its own start in between (the age rule was chosen over binding the
  session to the starting IP: the threat is a *second start*, which an IP check does not
  stop, and on a LAN the source address is both spoofable with ARP and shared behind
  tethering / emulators). The desktop user's rejection, attempt exhaustion, expiry or a failed
  save locks the window; the outcome stays on screen until dismissed and the user opens a new
  window explicitly. The last allowed attempt still completes after the lock. A session the
  desktop confirmed near the end of the window gets 30 s more to finish. Status polling (1/s)
  is only subject to the general per-IP limit, never the pairing limit.
* **Passive observers cannot kill a pairing**: the session id and nonces travel in plaintext,
  so anyone on the LAN can address a live session, but a `/pair/reveal` whose nonce does not
  match the commitment or a `/pair/finish` with a wrong proof is answered 403 *without*
  changing the session or locking the window: both values are unforgeable (SHA-256 preimage,
  HMAC under the confirmation key), guesses are bounded by the pairing rate limit, and the
  real phone's reveal / finish still goes through afterwards. Accepted residual: an attacker
  who keeps calling `/pair/start` first burns the window's attempts (every start counts) and
  denies pairing for that window; the desktop shows "attempt limit reached" for an attacker's
  session that never completes, and the window only exists for 2 minutes after an explicit
  click. A phone that gave up between start and reveal waits out the 10 s hold before it can
  start again.
* **Frames**: AES-256-GCM under per-direction keys, random 96-bit nonce, AAD binds
  `{ v, from, to, seq, ts, n, re, z }`. `seq` is a per-(peer, direction) monotonic counter:
  receivers persist the last accepted value (desktop: `sync-peers.json`; phone: next to the
  wrapped key in the Keystore-encrypted secret) and refuse anything not strictly greater, so a
  captured frame is dead after any restart and nothing depends on either clock (`ts` is
  informational). Counters are recorded only after the tag verified; senders persist their
  counter before the frame leaves. `re` binds a reply to its request nonce. Compressed bodies
  inflate through a stream capped at 32 MB. Any failure is a bare 401. The frame shape and
  sender id are validated and the sender looked up *before* anything is queued per sender,
  and a sender's queue entry is removed once it drained, so bogus frames leave no memory
  behind.
* **Backups and counter rollback** (desktop): `sync-peers.json` is ordinary user data, so a
  restored backup can carry older counters or an older key for a phone. `rxSeq` going back is
  harmless (the desktop merely accepts frames again that it would have refused). `txSeq`
  going back by N means the next N replies carry counters the phone already saw: the phone
  rejects each as a replay (`unverified`, nothing applied), while the desktop, which did run
  the merge, advances `txSeq` by one per attempt, so the pair recovers by itself after N
  syncs. A restored *key* (the phone re-paired after the backup) never recovers: every reply
  fails verification. The phone therefore keeps a per-desktop streak of unverifiable replies
  from the known address (`unverifiedStreak`, cleared by any success) and after 3 in a row
  says "This computer's sync data looks out of date ... unpair and pair again" instead of
  the generic "could not be verified". The phone's own secrets and record are excluded from
  backups, so there is no symmetric case.
* **Server**: random port, answers private/loopback addresses only, refuses browser-shaped
  requests (any `Origin` or `Sec-Fetch-*` header -> 403, POST not `application/json` -> 415,
  `Host` not an IP literal -> 403; note Node's own `fetch` is browser-shaped) *before* rate
  accounting, so a web page on the phone cannot spend the phone's per-IP budget; per-IP rate
  limits, 8 MB bodies, only while the toggle is on; stops and withdraws the mDNS record when
  off (quit waits, bounded, for the goodbye and pending writes). `/v1/info` returns
  `{ app, v }` only. A peer that cannot be persisted fails pairing with 503; counters that
  cannot be persisted fail the exchange with 503.
* **Device names** are attacker-controlled text shown next to the pairing code on the other
  screen. `names.mjs` strips C0/C1 controls and every Unicode format character (bidi
  overrides / isolates, zero-width characters, BOM, ALM, ...), collapses whitespace and caps
  the length; it runs on the server (phone names), in the peer store (the desktop's own name,
  which is also the mDNS instance name), in the client (desktop names) and on discovered
  mDNS names. The UI renders every name as an isolated left-to-right run (`dir="ltr"`,
  `unicode-bidi: isolate`) and the code always on a line of its own.
* **Discovery / privacy**: the mDNS instance name is the user-editable device name (default
  "Crossroads", never the hostname). TXT carries no id: `s` is a salt minted every time
  hosting starts and `h = H(deviceId | s)`; a paired phone recomputes `h` to spot its desktop,
  a passive listener gets nothing stable. Discovery is a hint only: the phone tries the
  services claiming to be its desktop, then the last known address, and believes a host only
  once an authenticated exchange completes. A claimant at a new address that fails
  authentication is reported as "a device on your network claims to be X but could not prove
  it"; "pair again" is said only when the known address rejects the phone's key.
* **Unpairing**: the phone sends an authenticated `/v1/unpair` frame (best effort) before
  forgetting the key. Unpairing on the desktop is one-sided: the phone learns about it when
  its next sync is refused.
* **Key storage**: desktop `sync-peers.json` (0600, outside electron-store); Android
  `SecretStore` (AES-GCM key in the Android Keystore, ciphertext in SharedPreferences). An
  entry is dropped only on provably unrecoverable errors: GCM tag failure, malformed blob,
  `KeyPermanentlyInvalidatedException`, or (API 33+) a `KeyStoreException` that is not
  flagged transient and reports the key as missing or corrupted. A plain
  `InvalidKeyException`, an `UnrecoverableKeyException`, a transient `KeyStoreException` or
  anything unclassifiable is reported as transient (code `transient`) and the entry is kept.
  The wrapping key is created only in `set()` and only while no blob exists; a missing alias
  while blobs exist (Keystore hiccup or wiped Keystore, indistinguishable from the app) is a
  transient error on both read and write, never a reason to drop entries or to mint a key
  that would orphan them. A wiped Keystore is resolved by the user unpairing the affected
  desktop (that deletes its blob); once no blob is left, the next pairing creates a key. The
  secrets file and the sync record are excluded from Auto Backup / device transfer: a
  restored key is undecryptable and a restored peer list would be misleading. A restored
  IndexedDB store with a fresh identity is discarded.
* **Android transport**: a minimal HTTP/1.1 client over a raw `Socket` (`LanHttpClient`:
  no proxy, no redirects, no DNS, Content-Length / chunked / EOF bodies, 8 MB cap), reached
  only through `SyncDiscoveryPlugin.request` and only for
  `http://<private IP literal>:<port>/v1/...` (`LanAddress`). Raw sockets are outside the
  network security config, so cleartext stays disabled for every platform HTTP stack and the
  app's single cleartext path is the one it controls; its payloads are encrypted by the frame
  layer anyway. (The WebView cannot fetch `http://` from `https://localhost`: mixed content.)
  Hostile replies cannot exhaust the phone: chunk sizes are parsed as hex digits only and
  compared against the remaining budget in `long` arithmetic before any byte is buffered,
  bodies are copied in 16 KB steps (nothing is allocated from a peer-supplied length),
  headers (100 lines / 32 KB), trailers (32 lines) and line lengths (8 KB) are capped, and a
  whole request has a wall-clock deadline of connect + 2 x read timeout, checked in every
  read loop and enforced by a watchdog that closes the socket, so a peer dripping one byte
  per timeout cannot hold the request open. An `OutOfMemoryError` or `StackOverflowError`
  while reading a reply rejects the request instead of crashing the app.
