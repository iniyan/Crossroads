// Wires the metadata tools (#20 track info / tag editor / MusicBrainz, #23 playlist
// import & export) into App.jsx with a single hook: App renders `overlay` and passes the
// `open*` / `exportPlaylist` / `importPlaylist` callbacks down to the views.

import React, { useCallback, useRef, useState } from 'react';
import Platform from '../services/PlatformService';
import TrackInfoPanel from '../components/metadata/TrackInfoPanel';
import TagEditor from '../components/metadata/TagEditor';
import MusicBrainzLookup from '../components/metadata/MusicBrainzLookup';
import PlaylistImportDialog from '../components/metadata/PlaylistImportDialog';
import { parseM3u, serializeM3u, resolveM3uEntries, playlistFileName, dirname } from '../library/m3u';

/**
 * @param {Object} params
 * @param {Object[]} params.songs
 * @param {(updated:Object[])=>void} params.onSongsUpdated   songs re-read after a tag write (matched by path)
 * @param {(name:string, songs:Object[])=>void} params.onCreatePlaylist
 */
export default function useMetadataTools({ songs, onSongsUpdated, onCreatePlaylist }) {
    const [dialog, setDialog] = useState(null);   // { type, ...props }
    const [notice, setNotice] = useState(null);
    const dialogRef = useRef(null);
    dialogRef.current = dialog;

    const close = useCallback(() => setDialog(null), []);
    // Back button / Escape: closes the open dialog and reports whether there was one.
    const closeOverlay = useCallback(() => {
        if (!dialogRef.current) return false;
        setDialog(null);
        return true;
    }, []);

    const openTrackInfo = useCallback((song, albumSongs = null) => {
        if (song) setDialog({ type: 'info', song, albumSongs });
    }, []);

    const openTagEditor = useCallback((list) => {
        const tracks = (Array.isArray(list) ? list : [list]).filter(Boolean);
        if (tracks.length) setDialog({ type: 'edit', songs: tracks });
    }, []);

    const openMusicBrainz = useCallback((list) => {
        const tracks = (Array.isArray(list) ? list : [list]).filter(Boolean);
        if (tracks.length) setDialog({ type: 'musicbrainz', songs: tracks });
    }, []);

    const handleSaved = useCallback((updated) => {
        if (updated?.length && onSongsUpdated) onSongsUpdated(updated);
    }, [onSongsUpdated]);

    const exportPlaylist = useCallback(async (playlist, playlistSongs) => {
        if (!playlistSongs?.length) { setNotice('This playlist is empty.'); return; }
        try {
            const result = await Platform.exportPlaylistFile({
                name: playlistFileName(playlist?.name),
                buildContent: ({ playlistDir, musicRoot }) => serializeM3u(playlistSongs, { playlistDir, musicRoot })
            });
            if (result?.canceled) return;
            setNotice(`Playlist exported${result?.path ? ` to ${result.path}` : result?.name ? ` as ${result.name}` : ''}.`);
        } catch (e) {
            setNotice(`Export failed: ${e?.message || e}`);
        }
    }, []);

    const importPlaylist = useCallback(async () => {
        try {
            const file = await Platform.importPlaylistFile();
            if (!file || file.canceled) return;
            const parsed = parseM3u(file.content || '');
            if (parsed.entries.length === 0) { setNotice('The playlist file has no entries.'); return; }
            const musicRoot = file.musicRoot || (await Platform.getMusicRoot());
            const playlistDir = file.path ? dirname(file.path) : null;
            const resolution = resolveM3uEntries(parsed.entries, songs, { playlistDir, musicRoot });
            setDialog({ type: 'import', fileName: file.name || 'playlist.m3u8', resolution });
        } catch (e) {
            setNotice(`Import failed: ${e?.message || e}`);
        }
    }, [songs]);

    let overlay = null;
    if (dialog?.type === 'info') {
        overlay = (
            <TrackInfoPanel
                song={dialog.song} albumSongs={dialog.albumSongs} onClose={close}
                onEdit={openTagEditor} onEditAlbum={openTagEditor} onMusicBrainz={openMusicBrainz}
            />
        );
    } else if (dialog?.type === 'edit') {
        overlay = <TagEditor songs={dialog.songs} onClose={close} onSaved={handleSaved} onMusicBrainz={openMusicBrainz} />;
    } else if (dialog?.type === 'musicbrainz') {
        overlay = <MusicBrainzLookup songs={dialog.songs} onClose={close} onSaved={handleSaved} />;
    } else if (dialog?.type === 'import') {
        overlay = (
            <PlaylistImportDialog
                fileName={dialog.fileName} resolution={dialog.resolution} onClose={close}
                onCreate={(name, matched) => { onCreatePlaylist(name, matched); close(); setNotice(`Playlist "${name}" created with ${matched.length} tracks.`); }}
            />
        );
    }

    const noticeEl = notice ? (
        <div className="meta-notice" onClick={() => setNotice(null)} style={{
            position: 'fixed', bottom: 110, left: '50%', transform: 'translateX(-50%)', zIndex: 2200,
            background: '#14141d', color: '#f8fafc', padding: '10px 16px', borderRadius: 10, fontSize: 13,
            border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', maxWidth: '90vw', cursor: 'pointer'
        }}>{notice}</div>
    ) : null;

    return {
        openTrackInfo, openTagEditor, openMusicBrainz, exportPlaylist, importPlaylist, closeOverlay,
        hasOverlay: !!dialog,
        overlay: <>{overlay}{noticeEl}</>
    };
}
