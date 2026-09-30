// Navigation position of the browsing views, kept at module level so leaving a view (or
// unmounting it) and coming back restores where the user was.
const viewMemory = { albumKey: null, foldersPath: [], composerKey: null, workKey: null };
export default viewMemory;
