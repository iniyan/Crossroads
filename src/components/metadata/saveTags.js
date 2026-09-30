// Runs tag writes one file at a time through PlatformService.writeTags, reporting progress and
// a per-file outcome. Shared by the tag editor and the MusicBrainz lookup.

import Platform from '../../services/PlatformService';
import { isEmptyOperations, isWritableFormat } from '../../library/tagEdit';

/** Error code the Android plugin returns when no folder grant covers the file. */
export const NEEDS_ACCESS = 'NEEDS_ACCESS';

/**
 * @param {{ song: Object, ops: {set:Object, remove:string[]} }[]} jobs
 * @param {Object} [opts]
 * @param {(progress:{done:number,total:number,song:Object})=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ results: {song:Object, status:'ok'|'skipped'|'error', strategy?:string, changed?:boolean, error?:string, code?:string, updated?:Object}[], updated: Object[], needsAccess: boolean }>}
 */
export const saveTagJobs = async (jobs, { onProgress = null, signal = null } = {}) => {
    const results = [];
    const updated = [];
    let needsAccess = false;
    let done = 0;
    for (const { song, ops } of jobs) {
        if (signal?.aborted) break;
        let result;
        if (!isWritableFormat(song.format)) {
            result = { song, status: 'skipped', error: `${song.format || 'This format'} is read-only` };
        } else if (isEmptyOperations(ops)) {
            result = { song, status: 'skipped', error: 'No changes' };
        } else {
            try {
                const written = await Platform.writeTags(song.path, ops);
                result = { song, status: 'ok', strategy: written?.strategy, changed: written?.changed !== false, updated: written?.song || null };
                if (written?.song) updated.push(written.song);
            } catch (e) {
                const code = e?.code || null;
                if (code === NEEDS_ACCESS) needsAccess = true;
                result = { song, status: 'error', error: e?.message || 'Write failed', code };
            }
        }
        results.push(result);
        done++;
        if (onProgress) onProgress({ done, total: jobs.length, song });
    }
    return { results, updated, needsAccess };
};
