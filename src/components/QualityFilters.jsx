import React, { useCallback, useEffect, useRef, useState } from 'react';
import Platform from '../services/PlatformService';
import { DEFAULT_FILTERS, normalizeFilters } from '../library/qualityGroups';
import '../styles/Quality.css';

export const FILTER_STORE_KEY = 'libraryFilters';

const CHIPS = [['all', 'All'], ['hires', 'Hi-Res'], ['cd', 'CD'], ['lossy', 'Lossy']];

// Persisted quality filter state. The saved value is read once on mount. A change made by the
// user before that read finishes wins over the saved value and is persisted once loaded.
export const useQualityFilters = () => {
    const [filters, setFilters] = useState(DEFAULT_FILTERS);
    const filtersRef = useRef(DEFAULT_FILTERS);
    const loadedRef = useRef(false);
    const touchedRef = useRef(false);

    const save = (value) => {
        Promise.resolve(Platform.setStore(FILTER_STORE_KEY, value))
            .catch(e => console.error(`Failed to save ${FILTER_STORE_KEY}`, e));
    };

    useEffect(() => {
        let cancelled = false;
        Promise.resolve(Platform.getStore(FILTER_STORE_KEY)).then(saved => {
            if (cancelled) return;
            loadedRef.current = true;
            if (touchedRef.current) save(filtersRef.current);
            else if (saved) { filtersRef.current = normalizeFilters(saved); setFilters(filtersRef.current); }
        }).catch(e => console.error(`Failed to load ${FILTER_STORE_KEY}; it will not be saved`, e));
        return () => { cancelled = true; };
    }, []);

    const update = useCallback((patch) => {
        touchedRef.current = true;
        const next = normalizeFilters({ ...filtersRef.current, ...patch });
        filtersRef.current = next;
        setFilters(next);
        if (loadedRef.current) save(next);
    }, []);
    return [filters, update];
};

const QualityFilters = ({ filters, onChange }) => (
    <div className="quality-filters" role="group" aria-label="Filter by quality">
        {CHIPS.map(([tier, label]) => (
            <button
                key={tier}
                className={`quality-chip ${filters.tier === tier ? 'active' : ''}`}
                aria-pressed={filters.tier === tier}
                onClick={() => onChange({ tier })}
            >
                {label}
            </button>
        ))}
        <label className="quality-toggle">
            <input
                type="checkbox"
                checked={filters.losslessOnly}
                onChange={(e) => onChange({ losslessOnly: e.target.checked })}
            />
            Lossless only
        </label>
    </div>
);

export default QualityFilters;
