// Önce ağ, olmazsa önbellek: uygulama dosyaları güncellenince hemen yenisi gelir, çevrimdışıyken açılır.
// Supabase API ve harita karoları önbelleğe alınmaz (her zaman ağdan).
const V = "aviadox-v7";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "splash.gif",
  "config.js",
  "notifications.js",
  "privacy.js",
  "app.js",
  "flightlog.js",
  "simulator.html",
  "weather.js",
  "slot.js",
  "i18n.js",
  "gizlilik.html",
  "manifest.webmanifest",
  "vendor/supabase.umd.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(V).then(c =>
      Promise.allSettled(SHELL.map(u => c.add(u).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.protocol !== "http:" && u.protocol !== "https:") return;
  if (u.origin !== location.origin && u.hostname !== "cdn.jsdelivr.net") return;
  e.respondWith(
    fetch(r).then(res => {
      if (res && res.ok && res.type !== "opaque") {
        const cp = res.clone();
        caches.open(V).then(c => c.put(r, cp)).catch(() => {});
      }
      return res;
    }).catch(() =>
      caches.match(r).then(m => m || (r.mode === "navigate" ? caches.match("index.html") : Response.error()))
    )
  );
});

// Web push: sunucu (slot-watch) Slot Merkezi değişince gönderir.
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(d.title || "AviaDoX", {
      body: d.body || "",
      tag: d.tag || "slot",
      renotify: true,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      data: { url: d.url || "./#sm" },
    })
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const u = new URL((e.notification.data && e.notification.data.url) || "./#sm", self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
      for (const c of cs) {
        if ("focus" in c) {
          if (typeof c.navigate === "function") c.navigate(u).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(u);
    })
  );
});
