import { useEffect } from 'react';

// Lets a view with its own inner navigation (folders, composers -> works) consume the Android
// back button before App's view history does. `handler` returns true when it navigated up.
export default function useViewBack(backRef, handler) {
    useEffect(() => {
        if (!backRef) return undefined;
        backRef.current = handler;
        return () => { if (backRef.current === handler) backRef.current = null; };
    });
}
