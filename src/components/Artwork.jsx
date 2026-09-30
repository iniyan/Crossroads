import React, { useState } from 'react';

// Album art image that renders `placeholder` when there is no source or the source
// failed to load. The failure is remembered per `src`, so a new song (or a retry with a
// different URL) gets a fresh attempt instead of inheriting a hidden <img>.
const Artwork = ({ src, alt = '', className, placeholder = null }) => {
    const [failedSrc, setFailedSrc] = useState(null);

    if (!src || failedSrc === src) return placeholder;

    return <img src={src} alt={alt} className={className} onError={() => setFailedSrc(src)} />;
};

export default Artwork;
