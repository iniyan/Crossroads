// Formats seconds as m:ss. Invalid/missing values return `fallback`.
export const formatTime = (seconds, fallback = '--:--') => {
    const s = Number(seconds);
    if (seconds === null || seconds === undefined || !Number.isFinite(s) || s < 0) return fallback;
    const minutes = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
};

// Formats seconds as "X min YY sec".
export const formatTotalTime = (seconds) => {
    const s = Number(seconds);
    const total = Number.isFinite(s) && s > 0 ? s : 0;
    const mins = Math.floor(total / 60);
    const secs = Math.floor(total % 60);
    return `${mins} min ${secs < 10 ? '0' : ''}${secs} sec`;
};
