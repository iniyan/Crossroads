import React from 'react';
import { TIER_NAMES } from '../library/qualityGroups';
import '../styles/Quality.css';

// Quality badge. Pass a song's `quality` ({ tier, label }) or an albumQuality() result
// (adds `mixed`). Renders nothing while the quality is still unknown (provisional rows).
const QualityBadge = ({ quality, mixed = false, compact = false, className = '' }) => {
    const tier = quality?.tier || 'unknown';
    if (tier === 'unknown') return null;
    const label = quality?.label || TIER_NAMES[tier] || '';
    return (
        <span
            className={`q-badge q-${tier} ${compact ? 'compact' : ''} ${className}`.trim()}
            title={mixed ? (quality?.breakdown || `Mixed quality (lowest: ${TIER_NAMES[tier] || label})`) : TIER_NAMES[tier] || label}
        >
            {label}
            {mixed && <span className="q-mixed">MIXED</span>}
        </span>
    );
};

export default QualityBadge;
