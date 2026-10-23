/* QuickLearn service worker
 * 1) Offline: keeps the app, fonts and libraries on the device so it opens with no internet.
 * 2) Background AI jobs: runs Gemini requests so they keep going when you leave the page,
 *    stores the result for the page to pick up, and sends a notification when it's done.
 * Place this file in the SAME folder as the app's HTML file.
 */
const CACHE = "quicklearn-cache";      // must match the name the page uses
const JOBS = "quicklearn-jobs";        // must match JOBS_CACHE in the page
const KEEP = [CACHE, JOBS];

const LOCAL_ASSETS = ["./", "index.html", "manifest.json", "favicon.svg", "icon-192.png", "apple-touch-icon.png"];
const CDN_ASSETS = [
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"
];
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap";

const isCacheable = r => r && (r.ok || r.type === "opaque");

/* ------------------------------ install / activate ------------------------------ */
self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Every item is saved on its own, so one missing file never blocks the install.
    await Promise.allSettled([
      ...LOCAL_ASSETS.map(u => cache.add(new Request(u, { cache: "reload" }))),
      ...CDN_ASSETS.map(async u => {
        let res;
        try { res = await fetch(u); } catch (_) { res = await fetch(u, { mode: "no-cors" }); }
        if (isCacheable(res)) await cache.put(u, res);
      }),
      precacheFonts(cache)
    ]);
    await self.skipWaiting();
  })());
});

// Save the Google Fonts stylesheet and the font files it points to.
async function precacheFonts(cache) {
  const res = await fetch(FONT_CSS);
  if (!res.ok) return;
  const css = await res.clone().text();
  await cache.put(FONT_CSS, res);
  const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))];
  await Promise.allSettled(urls.map(async u => {
    const f = await fetch(u);
    if (isCacheable(f)) await cache.put(u, f);
  }));
}

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => !KEEP.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* ------------------------------ fetch strategies ------------------------------ */
const CACHE_FIRST_HOSTS = ["fonts.gstatic.com", "cdnjs.cloudflare.com"];
const isFirebaseLib = u => u.hostname === "www.gstatic.com" && u.pathname.startsWith("/firebasejs/");

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.origin === location.origin && url.pathname.startsWith("/__job/")) return;

  if (req.mode === "navigate") { e.respondWith(handleNavigate(e)); return; }
  if (url.origin === location.origin || url.hostname === "fonts.googleapis.com") { e.respondWith(staleWhileRevalidate(e)); return; }
  if (CACHE_FIRST_HOSTS.includes(url.hostname) || isFirebaseLib(url)) { e.respondWith(cacheFirst(req)); return; }
  // Everything else (Gemini API, Firebase auth, links) goes straight to the network, never cached.
});

// A redirected response can't be served for a navigation in Safari, so rebuild it.
async function clean(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// Pages: try the network (so updates arrive), but fall back to the saved copy when offline or slow.
async function handleNavigate(e) {
  const req = e.request, cache = await caches.open(CACHE);
  const saved = await cache.match(req, { ignoreSearch: true })
    || await cache.match("./") || await cache.match("index.html");
  const net = fetch(req).then(async res => {
    if (res.ok) { const c = await clean(res); await cache.put(req, c.clone()); return c; }
    return res;
  });
  if (!saved) return net.catch(() => offlinePage());
  e.waitUntil(net.catch(() => {}));
  const slow = new Promise(r => setTimeout(() => r(null), 3500));
  try {
    const winner = await Promise.race([net, slow]);
    return (winner && winner.ok) ? winner : saved;
  } catch (_) { return saved; }
}

async function staleWhileRevalidate(e) {
  const req = e.request, cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => { if (isCacheable(res)) cache.put(req, res.clone()); return res; });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
  try { return await net; }
  catch (_) {
    return (await cache.match(req, { ignoreSearch: true })) || new Response("", { status: 503, statusText: "Offline" });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (isCacheable(res)) cache.put(req, res.clone());
    return res;
  } catch (_) { return new Response("", { status: 503, statusText: "Offline" }); }
}

function offlinePage() {
  return new Response("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>QuickLearn</title>" +
    "<body style='font-family:system-ui;background:#130c08;color:#fff;display:grid;place-items:center;height:100vh;margin:0;text-align:center'>" +
    "<div><h2>You're offline</h2><p>Open QuickLearn once with internet and it will work offline after that.</p></div>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/* ------------------------------ background AI jobs ------------------------------ */
const running = new Map();     // job id -> AbortController
const cancelled = new Set();

self.addEventListener("message", e => {
  const m = e.data || {};
  if (m.type === "gen") {
    if (e.ports && e.ports[0]) e.ports[0].postMessage("ack");
    e.waitUntil(runJob(m));
  } else if (m.type === "cancel") {
    cancelled.add(m.id);
    const ctl = running.get(m.id); if (ctl) ctl.abort();
  } else if (m.type === "skipWaiting") {
    self.skipWaiting();
  }
});

function sleep(ms, signal) {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("Cancelled")); }, { once: true });
  });
}

async function generate(m, signal) {
  const models = (m.models && m.models.length) ? m.models : ["gemini-flash-latest"];
  const delays = m.delays || [2000, 5000, 10000];
  const retryable = m.retryable || [429, 500, 502, 503, 504];
  const parts = [{ text: m.prompt }];
  (m.images || []).slice(0, 8).forEach(d => parts.push({ inline_data: { mime_type: "image/jpeg", data: d } }));
  const body = JSON.stringify({ contents: [{ parts }] });

  for (const model of models) {            // main model first, then the backup model
    const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + model +
      ":generateContent?key=" + encodeURIComponent(m.key);
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      let res = null;
      try {
        res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal });
      } catch (err) {
        if (signal.aborted) throw new Error("Cancelled");
        if (self.navigator && self.navigator.onLine === false) throw new Error("You lost your internet connection — AI features need it. Everything else still works.");
      }
      if (res && res.ok) {
        const j = await res.json();
        return (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || [])
          .map(p => p.text || "").join("");
      }
      if (res && !retryable.includes(res.status)) {
        const t = await res.text();
        if (res.status === 400 || res.status === 403) throw new Error("API key rejected — check it in the AI key dialog.");
        throw new Error("Gemini error " + res.status + ": " + t.slice(0, 120));
      }
      if (attempt < delays.length) await sleep(delays[attempt], signal);
    }
  }
  throw new Error("Gemini is still too busy even on the backup model. Please try again in a few minutes.");
}

async function runJob(m) {
  const ctl = new AbortController();
  running.set(m.id, ctl);
  let result;
  try { result = { ok: true, text: await generate(m, ctl.signal) }; }
  catch (err) { result = { ok: false, error: (err && err.message) || "Something went wrong." }; }
  running.delete(m.id);
  if (cancelled.delete(m.id)) return;                       // user cancelled: say nothing

  const jobs = await caches.open(JOBS);
  await jobs.put("/__job/" + m.id, new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } }));

  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  wins.forEach(c => c.postMessage({ type: "genDone", id: m.id }));

  // Only notify if nobody is looking at the app right now.
  if (!wins.some(c => c.visibilityState === "visible") && m.notify) {
    try {
      await self.registration.showNotification(m.notify.title || "QuickLearn", {
        body: result.ok ? m.notify.ok : m.notify.fail,
        icon: "icon-192.png", badge: "icon-192.png",
        tag: "quicklearn-" + (m.notify.hash || m.id),
        data: { hash: m.notify.hash }
      });
    } catch (_) { /* notifications not allowed: the page still collects the result */ }
  }
}

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const hash = e.notification.data && e.notification.data.hash;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.length) {
      const c = wins.find(w => w.visibilityState === "visible") || wins[0];
      await c.focus();
      if (hash) c.postMessage({ type: "goto", hash });
    } else {
      await self.clients.openWindow(self.registration.scope + (hash || ""));
    }
  })());
});
