# Audio processing (#24)

Parametric EQ with AutoEq presets and headphone crossfeed on the playback `<audio>` element.

| Module | Purpose |
| --- | --- |
| `dsp.js` | `DspEngine`: the Web Audio graph `MediaElementAudioSourceNode -> preamp Gain -> 10 BiquadFilters -> [crossfeed network] -> destination`, created lazily the first time processing is wanted. `apply(state)` re-wires and updates parameters; `active`, `routed`, `describe()`, `measure()` (analyser peak/RMS on the processed path, used by the Electron harness). The context is suspended while the element is paused and resumed on `play`. |
| `dspState.js` | Persisted settings (store key `dsp`): `normalizeDspState`, `DEFAULT_DSP_STATE`, built-in presets, band helpers, `dspWantsProcessing` (an enabled EQ needs at least one enabled band with a non-zero gain). |
| `eqMath.js` | Pure biquad maths with the Web Audio spec's coefficients (peaking, shelves, lowpass): `responseDb`, `curvePoints` (the drawn curve), `peakBoostDb`, `autoPreampDb` (clipping protection = −largest boost of the combined response, down to −60 dB; the UI warns above 24 dB of boost). |
| `crossfeed.js` | bs2b-style presets (Default 700 Hz/4.5 dB, Chu Moy 700/6, Jan Meier 650/9.5, Custom), `designCrossfeed` (lowpass + cross gain, lowshelf on the direct path so centred content stays flat within ±0.6 dB, no delay), `crossfeedResponse` (mono / hard-pan responses from the same biquad maths) and `crossfeedHeadroomDb` (taken in the preamp). |
| `autoeq.js` | Pure parsers for AutoEq's `results/INDEX.md` and `ParametricEQ.txt` (`Preamp: -x dB`, `Filter N: ON PK/LSC/HSC Fc … Gain … Q …`), `profileUrl`, `searchAutoEqIndex`, `formOf`. |
| `autoeqStore.js` | Fetches the index / a profile from `raw.githubusercontent.com` and caches them offline in the blob store (`src/services/blobStore.js`, IndexedDB; keys `autoeqIndex`, `autoeqProfiles`). A copy an earlier build left in the platform store is migrated once and cleared. |

## Routing rules

* The element keeps its native output path until the EQ or crossfeed is first enabled, so a
  user who never touches the DSP keeps bit-perfect playback.
* `createMediaElementSource()` is called once per element and can never be undone: from then on
  the element's audio goes through Web Audio (resampled to the context rate) for the rest of
  the session. **Bypass** = `source -> destination` with the whole chain disconnected; the
  Player shows "DSP" while processing is in the path and the signal-path note says when the
  output is no longer bit-perfect. A restart returns to native output.
* `audio.volume` still applies before the source node, so the volume slider keeps working.
  Pause / seek / ended, the OS media session and the Android foreground service all key off the
  element, which is unchanged.
* Background playback (Android): Capacitor keeps the WebView running (`KeepRunning` defaults to
  true, the WebView is never `onPause()`d) and Chromium does not suspend an `AudioContext` on
  visibility change, so the graph keeps rendering behind the foreground service. A context that
  is nonetheless suspended (autoplay policy, audio-focus interruption) is resumed on every
  `play` event, when the page becomes visible and whenever settings change.
* Mono files: the crossfeed network starts with a GainNode forced to 2 channels (`'explicit'`,
  `'speakers'`) so a mono stream is up-mixed to L = R before the ChannelSplitter, which is
  "discrete" and would otherwise feed silence to the right channel.
* Cross-origin media renders **silence** through a `MediaElementAudioSourceNode` unless it was
  fetched with CORS. `App.jsx` sets `audio.crossOrigin = 'anonymous'` before the first `src`;
  the Electron `crossroads-media://` scheme is registered with `corsEnabled` and answers with
  `Access-Control-Allow-Origin: crossroads-app://app` (or the Vite dev origin) on every
  track / art response, including 206 ranges and OPTIONS. On Android the Capacitor local server
  is same-origin. The same header lets vinyl mode read album-art pixels from a canvas.
* Shelving filters: Web Audio fixes the shelf slope (Q is ignored, spec `S = 1`); AutoEq writes
  shelves with Q 0.70, which is the same slope, so the field is shown greyed out.
