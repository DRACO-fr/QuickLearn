const CACHE = "quicklearn-cache";
const JOBS_CACHE = "quicklearn-jobs"; // finished AI results wait here until the app picks them up
const ASSETS = ["./", "./index.html", "./manifest.json", "./favicon.svg", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== JOBS_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "generativelanguage.googleapis.com") return; // never cache AI calls
  e.respondWith(fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; }).catch(() => caches.match(req).then(r => r || caches.match("./index.html"))));
});

/* ---------- Background AI jobs ---------- */
// The page hands a job to this worker, which keeps working even if the page is hidden or closed.
const running = new Map(); // job id -> AbortController
self.addEventListener("message", e => {
  const m = e.data;
  if (m && m.type === "cancel") { const ac = running.get(m.id); if (ac) ac.abort(); return; }
  if (!m || m.type !== "gen") return;
  if (e.ports && e.ports[0]) e.ports[0].postMessage("ack");
  e.waitUntil(runJob(m));
});

async function callGemini(m, signal) {
  const parts = [{ text: m.prompt }];
  (m.images || []).forEach(d => parts.push({ inline_data: { mime_type: "image/jpeg", data: d } }));
  const body = JSON.stringify({ contents: [{ parts }] });
  let reached = false;
  for (const model of m.models) {
    for (let a = 0; a <= m.delays.length; a++) {
      let res = null;
      try {
        res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(m.key), {
          method: "POST", headers: { "Content-Type": "application/json" }, body, signal
        });
      } catch (_) { if (signal.aborted) throw new Error("cancelled"); res = null; }
      if (res) reached = true;
      if (res && res.ok) {
        const j = await res.json();
        return (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || []).map(p => p.text || "").join("");
      }
      if (res && !m.retryable.includes(res.status)) {
        if (res.status === 400 || res.status === 403) throw new Error("API key rejected — check it in the AI key dialog.");
        const t = await res.text();
        throw new Error("Gemini error " + res.status + ": " + t.slice(0, 120));
      }
      if (a < m.delays.length) await new Promise(r => setTimeout(r, m.delays[a]));
      if (signal.aborted) throw new Error("cancelled");
    }
  }
  throw new Error(reached ? "Gemini is too busy right now. Please try again in a few minutes." : "Couldn't reach Gemini — check your internet connection.");
}

async function runJob(m) {
  const ac = new AbortController(); running.set(m.id, ac);
  let result;
  try { result = { ok: true, text: await callGemini(m, ac.signal) }; }
  catch (err) { result = { ok: false, error: String((err && err.message) || err) }; }
  running.delete(m.id);
  if (ac.signal.aborted) return; // cancelled: save nothing, notify nothing
  try {
    const c = await caches.open(JOBS_CACHE);
    await c.put("/__job/" + m.id, new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } }));
  } catch (_) {}
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  wins.forEach(w => w.postMessage({ type: "genDone", id: m.id }));
  const looking = wins.some(w => w.visibilityState === "visible");
  if (!looking && m.notify) {
    try {
      await self.registration.showNotification(m.notify.title || "QuickLearn", {
        body: result.ok ? m.notify.ok : m.notify.fail,
        icon: "icon-192.png", badge: "icon-192.png",
        tag: "job-" + m.id, data: { hash: m.notify.hash || "#/" }
      });
    } catch (_) {} // notifications not allowed: the result is still saved when the app opens
  }
}

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const hash = (e.notification.data && e.notification.data.hash) || "#/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    if (ws.length) { ws[0].focus(); ws[0].postMessage({ type: "goto", hash }); return; }
    return self.clients.openWindow("./index.html" + hash);
  }));
});
