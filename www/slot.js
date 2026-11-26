// Slot Merkezi sekmesi + Kapadokya gün doğumu bazlı dinamik 2 dk kontrol penceresi + bildirim aboneliği + METAR/TAF kartı.
const SLOT = (() => {
  const CACHE_KEY = "aviadox-slot-cache-v1";
  const CAP_LAT = 38.6431; // Kapadokya (Göreme/Nevşehir)
  const CAP_LON = 34.8289;
  const TR_TZ_MIN = 180;   // Türkiye sabit UTC+3
  const POLL_MS = 120000;  // 2 dakikada bir kontrol
  const PRE_SUNRISE_MIN = 45; // Gün doğumundan 45 dk önce başla
  const STOP_AFTER_MIN = 8 * 60; // Saat 08:00 (TR) sonrası tüm bölgeler Uçulmaz olunca dur

  let data = null, ts = "", host = null, started = false, ch = null, banner = "", pushOn = null, busy = "", pollT = null, refreshing = false;
  const FL = { red: ["🔴", "UÇULMAZ", "var(--er)"], yellow: ["🟡", "UÇULMAZ (sarı bayrak)", "var(--wa)"], green: ["🟢", "UÇULABİLİR", "var(--ok,#2e9e5b)"] };
  const sig = d => JSON.stringify([(d.items || []).map(i => i.flag), d.updated, d.valid]);
  const tm = s => s ? new Date(s).toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "";
  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const canOnline = () => typeof sb !== "undefined" && !!sb && typeof S !== "undefined" && !S.offline && !S.offlineGuest && navigator.onLine;

  /* ---------- Kapadokya (UTC+3) Astronomik Gün Doğumu (NOAA Solar Equations, ±1 dk hassasiyet) ---------- */
  const rad = d => d * Math.PI / 180;
  const deg = r => r * 180 / Math.PI;
  function fmtHM(totalMin) {
    const m = ((Math.round(totalMin) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  }
  function trParts(nowMs) {
    const d = new Date((nowMs || Date.now()) + TR_TZ_MIN * 60000);
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth(),
      day: d.getUTCDate(),
      min: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60,
    };
  }
  function cappadociaSunriseMin(y, mo, day) {
    const jd = Date.UTC(y, mo, day) / 86400000 + 2440587.5;
    const T = (jd - 2451545.0) / 36525.0;
    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const Mr = rad(M), L0r = rad(L0);
    const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
      + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T)
      + Math.sin(3 * Mr) * 0.000289;
    const omega = 125.04 - 1934.136 * T;
    const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(omega));
    const eps0 = 23 + (26 + ((21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60)) / 60;
    const eps = eps0 + 0.00256 * Math.cos(rad(omega));
    const decl = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));
    const varY = Math.tan(rad(eps) / 2) ** 2;
    const eqTime = 4 * deg(
      varY * Math.sin(2 * L0r)
      - 2 * e * Math.sin(Mr)
      + 4 * e * varY * Math.sin(Mr) * Math.cos(2 * L0r)
      - 0.5 * varY * varY * Math.sin(4 * L0r)
      - 1.25 * e * e * Math.sin(2 * Mr)
    );
    const cosHA = (Math.cos(rad(90.833)) / (Math.cos(rad(CAP_LAT)) * Math.cos(decl))) - Math.tan(rad(CAP_LAT)) * Math.tan(decl);
    const ha = deg(Math.acos(Math.max(-1, Math.min(1, cosHA))));
    const solarNoon = 720 - 4 * CAP_LON - eqTime + TR_TZ_MIN;
    return solarNoon - 4 * ha;
  }
  function allUnflyable(d) {
    return !!(d && Array.isArray(d.items) && d.items.length > 0 && d.items.every(i => i && i.flag !== "green"));
  }
  function windowState(nowMs) {
    const tr = trParts(nowMs);
    const sunriseMin = cappadociaSunriseMin(tr.y, tr.mo, tr.day);
    const startMin = sunriseMin - PRE_SUNRISE_MIN;
    if (tr.min < startMin) {
      return {
        phase: "waiting",
        sunriseMin,
        startMin,
        trMin: tr.min,
        waitMs: Math.max(5000, Math.min((startMin - tr.min) * 60000, 30 * 60000)),
      };
    }
    if (tr.min >= STOP_AFTER_MIN && allUnflyable(data)) {
      return {
        phase: "done",
        sunriseMin,
        startMin,
        trMin: tr.min,
        waitMs: 30 * 60000,
      };
    }
    return {
      phase: "active",
      sunriseMin,
      startMin,
      trMin: tr.min,
      waitMs: POLL_MS,
    };
  }

  function loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (c && c.data) { data = c.data; ts = c.ts || ""; }
    } catch (_) {}
  }
  function saveCache() {
    try { if (data) localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts })); } catch (_) {}
  }
  loadCache();

  function scheduleNext() {
    clearTimeout(pollT);
    pollT = null;
    if (!started) return;
    const w = windowState(Date.now());
    pollT = setTimeout(() => {
      const cur = windowState(Date.now());
      if (cur.phase === "active" && document.visibilityState !== "hidden") {
        load().catch(() => {}).finally(scheduleNext);
      } else {
        repaint();
        scheduleNext();
      }
    }, w.waitMs);
  }

  async function load() {
    if (!canOnline()) { repaint(); return; }
    const { data: r } = await sb.from("slot_status").select("data,updated_at").eq("id", 1).maybeSingle();
    if (r && r.data) {
      const old = data;
      data = r.data;
      ts = r.updated_at;
      saveCache();
      if (old && sig(old) !== sig(data)) banner = "🔔 Slot Merkezi güncellendi";
    }
    repaint();
    scheduleNext();
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    repaint();
    try {
      await load();
    } catch (_) {}
    refreshing = false;
    repaint();
  }
  function start() {
    if (started) return;
    started = true;
    load().catch(() => {});
    if (canOnline()) {
      try {
        ch = sb.channel("slot").on("postgres_changes", { event: "*", schema: "public", table: "slot_status" }, () => load().catch(() => {})).subscribe();
      } catch (_) {}
    }
    if (typeof AVNOTIF !== "undefined" && AVNOTIF.onPush) {
      AVNOTIF.onPush(() => {
        banner = "🔔 Slot Merkezi güncellendi";
        load().catch(() => {});
      });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        const w = windowState(Date.now());
        if (w.phase === "active") load().catch(() => {});
        else { repaint(); scheduleNext(); }
      }
    });
    window.addEventListener("online", () => {
      if (windowState(Date.now()).phase === "active") load().catch(() => {});
    });
    scheduleNext();
    checkPush();
  }
  const b64 = s => { const p = "=".repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
  const k = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  function support() {
    if (isNative()) return "native";
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return /iPhone|iPad/.test(navigator.userAgent) ? "ios" : "none";
    return "ok";
  }
  async function checkPush() {
    const s = support();
    if (s === "native") {
      try { pushOn = localStorage.getItem("aviadox-native-slot-push") === "1" || !!(typeof AVNOTIF !== "undefined" && AVNOTIF.getPushToken && AVNOTIF.getPushToken()); } catch (_) { pushOn = false; }
      repaint();
      return;
    }
    if (s !== "ok") { pushOn = false; return; }
    try { const reg = await navigator.serviceWorker.ready; pushOn = !!(await reg.pushManager.getSubscription()) && Notification.permission === "granted"; } catch (_) { pushOn = false; }
    repaint();
  }
  async function enable() {
    busy = "…"; repaint();
    try {
      if (support() === "native") {
        if (typeof AVNOTIF === "undefined" || !AVNOTIF.enablePushNotifications) {
          throw new Error("Bildirim modülü hazır değil.");
        }
        const res = await AVNOTIF.enablePushNotifications();
        if (!res.ok) throw new Error("Bildirim izni verilmedi. Cihaz ayarlarından bildirimlere izin verin.");
        try { localStorage.setItem("aviadox-native-slot-push", "1"); } catch (_) {}
        pushOn = true;
        if (typeof toast === "function") toast("Slot Merkezi bildirimleri açıldı ✔");
      } else {
        if (!canOnline()) throw new Error("İnternet bağlantısı gerekli.");
        if (await Notification.requestPermission() !== "granted") throw new Error("İzin verilmedi. Tarayıcı/telefon ayarlarından bildirimlere izin ver.");
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(AERODOX.VAPID_PUBLIC) });
        const { error } = await sb.from("push_subs").upsert({ user_id: S.user.id, endpoint: sub.endpoint, p256dh: k(sub.getKey("p256dh")), auth: k(sub.getKey("auth")) }, { onConflict: "endpoint" });
        if (error) throw error;
        pushOn = true;
        try { await reg.showNotification("AviaDoX", { body: "Slot Merkezi bildirimleri açıldı ✔", icon: "icons/icon-192.png" }); } catch (_) {}
      }
    } catch (e) { alert("Bildirim açılamadı: " + (e.message || e)); }
    busy = ""; repaint();
  }
  async function disable() {
    if (support() === "native") {
      try { localStorage.setItem("aviadox-native-slot-push", "0"); } catch (_) {}
      pushOn = false; repaint();
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
      if (sub) {
        if (canOnline()) await sb.from("push_subs").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
    } catch (_) {}
    pushOn = false; repaint();
  }
  function pushCard() {
    const s = support();
    let t;
    if (s === "ok" || s === "native") t = pushOn ? `<button class="sec" style="width:auto;margin:0" onclick="SLOT.off()">🔕 Bildirimi kapat</button>` : `<button style="width:auto;margin:0" onclick="SLOT.on()">🔔 Bildirimleri aç ${esc(busy)}</button>`;
    else if (s === "ios") t = '<span class="mu">iPhone\'da bildirim için uygulamayı Safari ▸ Paylaş ▸ <b>Ana Ekrana Ekle</b> ile ekleyip ana ekran simgesinden aç (iOS 16.4+), sonra bu butonu kullan.</span>';
    else t = '<span class="mu">Bu tarayıcı bildirimi desteklemiyor.</span>';
    return `<div class="card" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:150px"><b>Bildirim</b><div class="mu">Slot kararı değiştiğinde haber ver</div></div>${t}</div>`;
  }
  function flagCards() {
    if (!data || !data.items) return '<p class="mu">Veri bekleniyor… (ilk güncelleme birkaç dakika sürebilir)</p>';
    return `<div class="grid">${data.items.map(i => { const f = FL[i.flag] || ["⚪", i.label || "—", "var(--mu)"]; return `<div class="card stat"><b style="color:${f[2]}">${f[0]}</b><div style="font-weight:700">${esc(i.name)}</div><div class="mu">${esc(f[1])}</div></div>`; }).join("")}</div>`;
  }
  function metarCard() {
    if (!data) return "";
    const taf = data.taf ? esc(data.taf) : `<span class="mu">TAF şu an alınamadı${data.tafErr ? " (kaynak: " + esc(data.tafErr.slice(0, 80)) + ")" : ""}.</span>`;
    return `<h2>METAR / TAF (LTAZ)</h2><div class="card"><div class="mu">METAR</div><div style="font-family:monospace;word-break:break-word">${esc(data.metar || "—")}</div><div class="mu" style="margin-top:10px">TAF</div><div style="font-family:monospace;word-break:break-word">${taf}</div><div class="mu" style="margin-top:8px">Kaynak: Slot Merkezi sayfası (HEZARFEN Rasat)</div></div>`;
  }
  function scheduleInfoHtml() {
    const w = windowState(Date.now());
    const sr = fmtHM(w.sunriseMin);
    const st = fmtHM(w.startMin);
    const statusText = w.phase === "active"
      ? `🟢 Otomatik kontrol aktif (2 dk aralık)`
      : w.phase === "waiting"
        ? `⏳ Otomatik kontrol beklemede (${st}'de başlar)`
        : `⏹ Otomatik kontrol durdu (08:00 sonrası tüm bölgeler Uçulmaz)`;
    return `<div class="mu" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bd)">☀️ Kapadokya gün doğumu: <b>${sr}</b> · Başlangıç: <b>${st}</b><br>${statusText}</div>`;
  }
  function view() {
    const d = data || {};
    return `${banner ? `<div class="card" style="border-color:var(--pr)"><b>${esc(banner)}</b></div>` : ""}<div class="card"><div class="row" style="align-items:flex-start"><div style="flex:1;min-width:0"><b>Kapadokya Slot Merkezi</b><div class="mu">${d.updated ? "Güncelleme: " + esc(d.updated) : "Henüz veri yok"}${d.valid ? "<br>Geçerli: " + esc(d.valid) : ""}</div></div><button class="sec" style="width:auto;margin:0;padding:6px 10px;font-size:13px" onclick="SLOT.refresh()" ${refreshing ? "disabled" : ""}>${refreshing ? "…" : "↻ Yenile"}</button></div>${scheduleInfoHtml()}</div>${flagCards()}${pushCard()}<p class="mu" style="margin-top:10px">Kırmızı/sarı bayrak: kalkış izni verilmez. Yeşilde nihai uçuş kararı pilot ve işletmeye aittir. Bilgi resmî sayfadan otomatik alınır ve gecikebilir; resmî kaynağı esas alın. <a href="https://shmkapadokya.kapadokya.edu.tr" target="_blank" rel="noopener noreferrer" onclick="if(typeof openExternalUrl==='function'){openExternalUrl(this.href);return false;}">Slot Merkezi sayfası ↗</a>${ts ? " · Son kontrol: " + esc(tm(ts)) : ""}</p>`;
  }
  function repaint() { if (host && host.isConnected) host.innerHTML = view(); if (typeof WX !== "undefined" && WX.slotChanged) WX.slotChanged(); }
  return {
    start,
    mount(el) { host = el; banner = ""; repaint(); load().catch(() => {}); },
    refresh,
    on: enable,
    off: disable,
    metarCard,
    windowState,
    get data() { return data; },
  };
})();
