import React, { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import qualityStore from '../../analysis/qualityStore';
import QualityPanel from './QualityPanel';
import QualityProgress from './QualityProgress';
import '../../styles/Analysis.css';

const QualityContext = createContext(qualityStore);

/**
 * Mounts the analysis details panel and the progress toast once, above the app. Badges and
 * buttons anywhere below read the store through useQuality().
 */
export function QualityProvider({ children }) {
    useEffect(() => { qualityStore.init(); }, []);
    return (
        <QualityContext.Provider value={qualityStore}>
            {children}
            <QualityPanel />
            <QualityProgress />
        </QualityContext.Provider>
    );
}

/**
 * The quality store; the component re-renders when results, the library, the panel or the
 * queue's job list change, but not on per-window progress ticks (see useQualityProgress).
 */
export function useQuality() {
    const store = useContext(QualityContext);
    useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
    return store;
}

/** The running job's { done, total } window progress; re-renders on every tick. */
export function useQualityProgress() {
    const store = useContext(QualityContext);
    useSyncExternalStore(store.subscribeProgress, store.getProgressVersion, store.getProgressVersion);
    return store.getProgress();
}

/**
 * Keeps the store informed about the library, the root it was scanned from (a ref, read
 * when the songs change) and playback (call once from App).
 */
export function useQualityLibrary(songs, isPlaying, rootRef = null) {
    useEffect(() => { qualityStore.setLibrary(songs, rootRef ? rootRef.current : null); }, [songs]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { qualityStore.setPlaybackActive(isPlaying); }, [isPlaying]);
}

export default QualityProvider;
