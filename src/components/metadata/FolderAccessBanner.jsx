import React, { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import Platform from '../../services/PlatformService';

/**
 * Android: files owned by other apps are only writable (and non-media sidecars only readable)
 * through a Storage Access Framework folder grant. Shows the explanation and the grant
 * button; `onGranted` fires once a grant covering `path` exists.
 */
const FolderAccessBanner = ({ path, purpose = 'edit tags', onGranted, className = '' }) => {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);

    const request = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const grants = await Platform.requestFolderAccess();
            const ok = path ? await Platform.canAccessFile(path) : grants.length > 0;
            if (ok) {
                if (onGranted) onGranted(grants);
            } else if (grants.length > 0) {
                setMessage(`The chosen folder does not contain this file (${grants.map(g => g.path).join(', ')}). Pick the folder that holds your music.`);
            } else {
                setMessage('No folder was granted.');
            }
        } catch (e) {
            setMessage(e?.message || 'Folder access request failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={`meta-banner ${className}`}>
            <FolderOpen size={18} />
            <div>
                Grant folder access to {purpose}. Pick your Music folder (or the whole storage); the grant is remembered.
                {message && <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>{message}</div>}
            </div>
            <button className="meta-btn primary" onClick={request} disabled={busy}>
                {busy ? 'Waiting…' : 'Grant folder access'}
            </button>
        </div>
    );
};

export default FolderAccessBanner;
