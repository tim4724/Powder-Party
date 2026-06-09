// WakeLock — keeps the screen awake via the Screen Wake Lock API.
// The browser silently releases the lock whenever the tab is hidden, so the
// module re-acquires on the next visibilitychange back to visible — callers
// arm it once. No-ops where the API is missing or the request is denied
// (battery saver): a dimming screen is a papercut, never an error.

let sentinel = null;
let wanted = false; // re-acquire when the page becomes visible again?

async function acquire() {
  if (!navigator.wakeLock || sentinel || document.visibilityState !== 'visible') return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!wanted) { lock.release().catch(() => {}); return; } // letScreenSleep() raced the request
    sentinel = lock;
    lock.addEventListener('release', () => { if (sentinel === lock) sentinel = null; });
  } catch (_) { /* denied (e.g. battery saver) — the next visibilitychange retries */ }
}

export function keepScreenOn() {
  wanted = true;
  acquire();
}

export function letScreenSleep() {
  wanted = false;
  if (sentinel) { sentinel.release().catch(() => {}); sentinel = null; }
}

document.addEventListener('visibilitychange', () => {
  if (wanted && document.visibilityState === 'visible') acquire();
});
