import { Buffer } from 'buffer/';
(window as any).Buffer = Buffer;
(window as any).global = window;

import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Stale-chunk recovery: after a new deploy, hashed chunk filenames change. A page
// that was already open (or has an old index.html cached) can try to lazy-load an
// old chunk hash that no longer exists on the server → "Failed to fetch dynamically
// imported module", which otherwise crashes into the error boundary. Vite fires
// `vite:preloadError` when a dynamic import fails; reload to pick up the fresh chunk
// manifest. Two layers guard against an infinite reload loop when a chunk is
// genuinely missing (rather than merely stale):
//   1. a per-tab sessionStorage timestamp (survives the reload), and
//   2. an in-memory flag (fallback when sessionStorage is blocked in strict private
//      mode — at least prevents multiple reloads within a single page session).
// If a reload has already happened recently, the error is left to surface to the
// error boundary instead of reloading again.
let preloadReloadTriggered = false;
window.addEventListener("vite:preloadError", (event) => {
  const KEY = "vite:lastPreloadReload";
  if (preloadReloadTriggered) return; // already reloading this session → let it surface
  let last = 0;
  try {
    last = Number(window.sessionStorage.getItem(KEY) || "0");
  } catch {
    /* sessionStorage blocked — rely on the in-memory flag below */
  }
  if (Date.now() - last < 10000) return; // reloaded very recently → let it surface
  preloadReloadTriggered = true;
  try {
    window.sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  event.preventDefault(); // we're handling it via reload; suppress the uncaught throw
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(<App />);
