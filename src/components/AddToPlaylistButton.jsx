import React, { useEffect, useRef, useState } from 'react';
import { ListPlus } from 'lucide-react';

// "Add to playlist" button with a dropdown of the user's playlists. `getSongs` is evaluated on pick.
// Only one menu is open at a time: opening one broadcasts its id and the others close.
let nextId = 0;
const OPEN_EVENT = 'add-pl-menu-open';

const AddToPlaylistButton = ({ playlists = [], getSongs, onAddToPlaylist, label = 'Add to playlist' }) => {
    const [open, setOpen] = useState(false);
    const idRef = useRef(null);
    if (idRef.current === null) idRef.current = ++nextId;

    useEffect(() => {
        if (!open) return undefined;
        const close = () => setOpen(false);
        const onOther = (e) => { if (e.detail !== idRef.current) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('click', close);
        document.addEventListener('keydown', onKey);
        window.addEventListener(OPEN_EVENT, onOther);
        return () => {
            document.removeEventListener('click', close);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener(OPEN_EVENT, onOther);
        };
    }, [open]);

    const toggle = (e) => {
        e.stopPropagation();
        if (!open) window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: idRef.current }));
        setOpen(o => !o);
    };

    return (
        <div className="add-pl-wrap">
            <button className="shuffle-btn-flat" onClick={toggle}>
                <ListPlus size={20} /> {label}
            </button>
            {open && (
                <div className="context-menu add-pl-menu" onClick={(e) => e.stopPropagation()}>
                    <div className="menu-header">Add to Playlist</div>
                    {playlists.length === 0 ? (
                        <div className="menu-item disabled">No Playlists</div>
                    ) : playlists.map(pl => (
                        <div key={pl.id} className="menu-item" onClick={() => { onAddToPlaylist(pl.id, getSongs()); setOpen(false); }}>
                            {pl.name}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default AddToPlaylistButton;
