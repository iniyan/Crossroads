// Display-name sanitising shared by the desktop server, the desktop peer store and the phone
// (#25). A device name is attacker-controlled text that lands next to a pairing code on the
// other screen: control characters, bidi overrides / isolates, zero-width and other invisible
// format characters could make "Pixel" look like something else or reorder the digits. They
// are stripped, whitespace is collapsed and the length is capped. The UI additionally renders
// every name in an isolated LTR span and keeps the code on a line of its own.

export const MAX_DISPLAY_NAME = 64;

// Explicit ranges (the ones that matter even if the engine's Unicode tables were old) plus
// the general categories Cc (controls) and Cf (format: bidi controls, ZW*, BOM, ALM, ...).
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿؜᠎\p{Cc}\p{Cf}]/gu;

/** Printable, single-line, length-capped version of `v`; '' when nothing printable is left. */
export const cleanDisplayName = (v, max = MAX_DISPLAY_NAME) => {
    if (typeof v !== 'string') return '';
    return v.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
};
