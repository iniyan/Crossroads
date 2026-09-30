// Web Audio processing graph on the playback <audio> element (#24).
//
//   MediaElementAudioSourceNode -> preamp Gain -> up to 10 BiquadFilters -> [crossfeed] -> destination
//
//   crossfeed = upmix Gain (mono -> L=R) -> ChannelSplitter -> { lowshelf (direct)        -> own channel
//                                                              lowpass -> Gain (cross)  -> other channel } -> ChannelMerger
//
// Routing decisions
//   - Nothing is created until processing is first wanted, so a user who never touches the
//     EQ keeps the element's native output path (bit-perfect, no resampling).
//   - createMediaElementSource() can only be called once per element and can never be
//     undone: from that moment the element's audio goes through Web Audio for the rest of
//     the session (the element's own volume/muted still apply *before* the source node, so
//     the volume slider keeps working). "Bypass" therefore means reconnecting the source
//     straight to the destination and disconnecting the DSP chain, which is what the user
//     hears as unprocessed; the AudioContext resample (element rate -> context rate) remains
//     until the app restarts. The Player shows "DSP" while processing is active; bypassed
//     is reported separately so the signal-path note can say so.
//   - Pause/seek/ended events, the media session mirroring and the Android foreground
//     service all key off the element, which keeps playing normally; only its output sink
//     changes. The AudioContext is suspended while the element is paused (and after it
//     ends with nothing next) so the render thread idles, and resumed on every 'play' event;
//     none of that touches the element's events. Background playback on Android: Capacitor
//     keeps the WebView running (KeepRunning=true, the WebView is never onPause()d) and
//     Chromium does not suspend an AudioContext on visibility change, so the graph keeps
//     rendering behind the foreground service. A context left suspended by the autoplay
//     policy or an audio-focus interruption is resumed on 'play', when the page becomes
//     visible while playing and whenever settings change while playing.
//   - Mono sources: a BiquadFilter passes a mono stream through as mono, and a
//     ChannelSplitter is "discrete" (channel 1 would be silence), so the crossfeed network
//     starts with a GainNode forced to 2 channels with 'speakers' interpretation, which
//     up-mixes mono to L = R. Without it a mono file would come out lowpassed on the right.
//
// Cross-origin media: a MediaElementAudioSourceNode on cross-origin media renders silence
// unless the media was fetched with CORS. App.jsx sets audio.crossOrigin = 'anonymous'
// before the first src and the Electron media scheme answers with Access-Control-Allow-Origin
// (see electron/main.js); on Android the Capacitor server is same-origin.

import { effectivePreampDb, dbToLinear, MIN_PREAMP, MAX_PREAMP } from './eqMath.js';
import { resolveCrossfeed, designCrossfeed, crossfeedHeadroomDb } from './crossfeed.js';
import { MAX_BANDS } from './autoeq.js';
import { dspWantsProcessing, normalizeDspState, effectiveBands } from './dspState.js';

const AudioContextCtor = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

export class DspEngine {
    /**
     * @param {HTMLMediaElement} audio
     * @param {{ createContext?: () => AudioContext }} [options]  test hook
     */
    constructor(audio, options = {}) {
        this.audio = audio;
        this.createContext = options.createContext || (() => new AudioContextCtor());
        this.supported = options.createContext ? true : !!AudioContextCtor;
        this.ctx = null;
        this.source = null;
        this.nodes = null;
        this.state = normalizeDspState(null);
        this.listeners = new Set();
        this.lastError = null;
        this.onPlay = () => this.resume();
        // 'pause' fires right before 'ended' too; onEnded decides for that case.
        this.onPause = () => { if (!this.audio.ended) this.suspend(); };
        // Whatever followed the end (next track, repeat) has already called play() by the
        // time this runs, so a still-paused element means nothing is next.
        this.onEnded = () => { setTimeout(() => { if (this.audio.paused) this.suspend(); }, 0); };
        this.onVisibility = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') this.resumeIfPlaying(); };
    }

    /** True once the element has been routed through Web Audio (irreversible this session). */
    get routed() { return this.source !== null; }

    /** True while the DSP chain is in the signal path. */
    get active() { return this.routed && dspWantsProcessing(this.state); }

    get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        this.listeners.forEach(listener => { try { listener(this); } catch (e) { console.error(e); } });
    }

    /**
     * Applies a (normalised) DSP state. Creates the context on first need; afterwards only
     * re-wires the graph and updates parameters. Safe to call at any time, including before
     * the first user gesture (a suspended context is resumed on the next 'play').
     */
    apply(state) {
        this.state = normalizeDspState(state);
        const wanted = dspWantsProcessing(this.state);
        if (!this.routed) {
            if (!wanted) { this.notify(); return; }
            if (!this.ensureGraph()) { this.notify(); return; }
        }
        this.updateParameters();
        this.wire(wanted);
        this.resumeIfPlaying();
        this.notify();
    }

    ensureGraph() {
        if (this.routed) return true;
        if (!this.supported) { this.lastError = 'Web Audio is not available'; return false; }
        try {
            const ctx = this.ctx || this.createContext();
            this.ctx = ctx;
            const source = ctx.createMediaElementSource(this.audio);
            const preamp = ctx.createGain();
            const filters = [];
            for (let i = 0; i < MAX_BANDS; i++) {
                const filter = ctx.createBiquadFilter();
                filter.type = 'peaking';
                filter.frequency.value = 1000;
                filter.gain.value = 0;
                filter.Q.value = 1;
                filters.push(filter);
                if (i > 0) filters[i - 1].connect(filter);
            }
            preamp.connect(filters[0]);

            // Crossfeed network (see the header and crossfeed.js for the design).
            const upmix = ctx.createGain();
            upmix.channelCount = 2;
            upmix.channelCountMode = 'explicit';
            upmix.channelInterpretation = 'speakers';
            const splitter = ctx.createChannelSplitter(2);
            const merger = ctx.createChannelMerger(2);
            const shelfL = ctx.createBiquadFilter();     // direct paths: lowshelf cut of 1/(1+r)
            const shelfR = ctx.createBiquadFilter();
            const lowpassL = ctx.createBiquadFilter();   // cross paths: lowpass then level
            const lowpassR = ctx.createBiquadFilter();
            const crossL = ctx.createGain();             // L -> R
            const crossR = ctx.createGain();             // R -> L
            [shelfL, shelfR].forEach(shelf => { shelf.type = 'lowshelf'; shelf.frequency.value = 400; shelf.gain.value = 0; });
            [lowpassL, lowpassR].forEach(lp => { lp.type = 'lowpass'; lp.frequency.value = 1000; lp.Q.value = -6; });
            upmix.connect(splitter);
            splitter.connect(shelfL, 0); shelfL.connect(merger, 0, 0);
            splitter.connect(shelfR, 1); shelfR.connect(merger, 0, 1);
            splitter.connect(lowpassL, 0); lowpassL.connect(crossL); crossL.connect(merger, 0, 1);
            splitter.connect(lowpassR, 1); lowpassR.connect(crossR); crossR.connect(merger, 0, 0);

            // Output tap: an analyser on the processed path, for diagnostics (measure()).
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            analyser.connect(ctx.destination);

            this.source = source;
            this.nodes = { preamp, filters, upmix, splitter, merger, shelfL, shelfR, lowpassL, lowpassR, crossL, crossR, analyser };
            this.audio.addEventListener('play', this.onPlay);
            this.audio.addEventListener('pause', this.onPause);
            this.audio.addEventListener('ended', this.onEnded);
            if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
            this.lastError = null;
            return true;
        } catch (e) {
            console.error('DSP graph could not be created', e);
            this.lastError = e && e.message ? e.message : String(e);
            return false;
        }
    }

    /** Preamp in dB: the EQ's clipping protection plus the crossfeed's headroom. */
    preampDb() {
        const { eq, crossfeed } = this.state;
        let db = 0;
        if (eq.enabled && effectiveBands(eq).length > 0) db += clamp(effectivePreampDb(eq, this.sampleRate), MIN_PREAMP, MAX_PREAMP);
        if (crossfeed.enabled) {
            const { fcut, feed } = resolveCrossfeed(crossfeed);
            db += crossfeedHeadroomDb(designCrossfeed(fcut, feed), this.sampleRate);
        }
        return db;
    }

    updateParameters() {
        const { eq, crossfeed } = this.state;
        const { preamp, filters, shelfL, shelfR, lowpassL, lowpassR, crossL, crossR } = this.nodes;
        const now = this.ctx.currentTime;
        const ramp = (param, value) => {
            try {
                param.cancelScheduledValues(now);
                param.setTargetAtTime(value, now, 0.01);
            } catch {
                param.value = value;
            }
        };

        ramp(preamp.gain, dbToLinear(this.preampDb()));
        const bands = eq.enabled ? effectiveBands(eq) : [];
        filters.forEach((filter, i) => {
            const band = bands[i];
            if (!band) {
                // Transparent: a 0 dB peaking filter is unity regardless of frequency / Q.
                if (filter.type !== 'peaking') filter.type = 'peaking';
                ramp(filter.gain, 0);
                return;
            }
            if (filter.type !== band.type) filter.type = band.type;
            const nyquist = this.sampleRate / 2;
            ramp(filter.frequency, clamp(band.frequency, 10, nyquist * 0.999));
            ramp(filter.Q, band.q);
            ramp(filter.gain, band.gain);
        });

        const { fcut, feed } = resolveCrossfeed(crossfeed);
        const design = designCrossfeed(fcut, feed);
        [lowpassL, lowpassR].forEach(lp => { ramp(lp.frequency, design.lowpassFrequency); ramp(lp.Q, design.lowpassQ); });
        [shelfL, shelfR].forEach(shelf => { ramp(shelf.frequency, design.shelfFrequency); ramp(shelf.gain, design.shelfGainDb); });
        ramp(crossL.gain, design.crossGain);
        ramp(crossR.gain, design.crossGain);
    }

    /** Rewires source -> chain -> destination, or source -> destination when nothing is wanted. */
    wire(wanted) {
        const { preamp, filters, upmix, merger, analyser } = this.nodes;
        const last = filters[filters.length - 1];
        const { crossfeed } = this.state;
        try { this.source.disconnect(); } catch { /* not connected */ }
        try { last.disconnect(); } catch { /* not connected */ }
        try { merger.disconnect(); } catch { /* not connected */ }

        if (!wanted) {
            this.source.connect(this.ctx.destination);
            this.wiring = 'bypass';
            return;
        }
        this.source.connect(preamp);
        if (crossfeed.enabled) {
            last.connect(upmix);
            merger.connect(analyser);
            this.wiring = 'eq+crossfeed';
        } else {
            last.connect(analyser);
            this.wiring = 'eq';
        }
    }

    resume() {
        const ctx = this.ctx;
        if (!ctx || ctx.state !== 'suspended' || typeof ctx.resume !== 'function') return;
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(e => console.warn('AudioContext resume failed', e));
    }

    /** Resumes unless the element is paused (a paused element needs no rendering). */
    resumeIfPlaying() {
        if (this.audio.paused === true) return;
        this.resume();
    }

    suspend() {
        const ctx = this.ctx;
        if (!ctx || ctx.state !== 'running' || typeof ctx.suspend !== 'function') return;
        const p = ctx.suspend();
        if (p && typeof p.catch === 'function') p.catch(e => console.warn('AudioContext suspend failed', e));
    }

    /** Peak / RMS of the last analyser frame on the processed path (0 when bypassed). */
    measure() {
        if (!this.nodes || this.wiring === 'bypass') return { peak: 0, rms: 0, wiring: this.wiring || 'native', contextState: this.ctx?.state || 'none' };
        const analyser = this.nodes.analyser;
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        let peak = 0, sum = 0;
        for (let i = 0; i < data.length; i++) {
            const v = Math.abs(data[i]);
            if (v > peak) peak = v;
            sum += data[i] * data[i];
        }
        return { peak, rms: Math.sqrt(sum / data.length), wiring: this.wiring, contextState: this.ctx.state };
    }

    /** Short description for the signal-path note. */
    describe() {
        if (!this.routed) return 'Native output: the audio element plays directly (bit-perfect).';
        if (this.wiring === 'bypass') return `Bypassed: element -> output through Web Audio at ${this.sampleRate} Hz (no filters; not bit-perfect until restart).`;
        const { eq, crossfeed } = this.state;
        const parts = [];
        if (eq.enabled && effectiveBands(eq).length) parts.push(`${effectiveBands(eq).length}-band EQ`);
        if (crossfeed.enabled) parts.push('crossfeed');
        return `DSP active (${parts.join(' + ')}, preamp ${this.preampDb().toFixed(1)} dB) at ${this.sampleRate} Hz. Not bit-perfect.`;
    }

    destroy() {
        this.audio.removeEventListener('play', this.onPlay);
        this.audio.removeEventListener('pause', this.onPause);
        this.audio.removeEventListener('ended', this.onEnded);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
        this.listeners.clear();
    }
}
