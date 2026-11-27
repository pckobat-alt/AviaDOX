// Slot Merkezi sekmesi + Ayarlar'dan yönetilebilen Kapadokya gün doğumu bazlı otomatik kontrol + gerçek yerel/push bildirim + METAR/TAF kartı.
const SLOT = (() => {
  const CACHE_KEY = "aviadox-slot-cache-v1";
  const CFG_KEY = "aviadox-slot-cfg-v1";
  const NATIVE_NOTIF_KEY = "aviadox-native-slot-push";
  const CAP_LAT = 38.6431; // Kapadokya (Göreme/Nevşehir)
  const CAP_LON = 34.8289;
  const TR_TZ_MIN = 180;   // Türkiye sabit UTC+3

  const DEFAULT_CFG = {
    enabled: true,
    intervalMin: 2,
    preSunriseMin: 45,
    stopAfter: "08:00",
  };

  let cfg = loadCfg();
  let data = null, ts = "", host = null, started = false, ch = null, banner = "", pushOn = null, busy = "", pollT = null, refreshing = false;
  const FL = { red: ["🔴", "UÇULMAZ", "var(--er)"], yellow: ["🟡", "UÇULMAZ (sarı bayrak)", "var(--wa)"], green: ["🟢", "UÇULABİLİR", "var(--ok,#2e9e5b)"] };
  const sig = d => JSON.stringify([(d.items || []).map(i => i.flag), d.updated, d.valid]);
  const tm = s => s ? new Date(s).toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "";
  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const canOnline = () => typeof sb !== "undefined" && !!sb && typeof S !== "undefined" && !S.offline && !S.offlineGuest && navigator.onLine;

  function parseHM(str, fallbackMin) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
    if (!m) return fallbackMin;
    const h = Math.max(0, Math.min(23, Number(m[1])));
    const mn = Math.max(0, Math.min(59, Number(m[2])));
    return h * 60 + mn;
  }
  function sanitizeCfg(raw) {
    const c = raw && typeof raw === "object" ? raw : {};
    const enabled = c.enabled !== false;
    const intervalMin = Math.max(1, Math.min(30, Math.round(Number(c.intervalMin) || DEFAULT_CFG.intervalMin)));
    const preSunriseMin = Math.max(0, Math.min(180, Math.round(c.preSunriseMin == null || c.preSunriseMin === "" ? DEFAULT_CFG.preSunriseMin : Number(c.preSunriseMin))));
    const stopMin = parseHM(c.stopAfter, 480);
    const stopAfter = String(Math.floor(stopMin / 60)).padStart(2, "0") + ":" + String(stopMin % 60).padStart(2, "0");
    return { enabled, intervalMin, preSunriseMin, stopAfter };
  }
  function loadCfg() {
    try {
      return sanitizeCfg(JSON.parse(localStorage.getItem(CFG_KEY) || "null"));
    } catch (_) {
      return { ...DEFAULT_CFG };
    }
  }
  function saveCfg(next) {
    cfg = sanitizeCfg(next);
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (_) {}
    scheduleNext();
    repaint();
    return cfg;
  }

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
    const startMin = sunriseMin - cfg.preSunriseMin;
    const stopAfterMin = parseHM(cfg.stopAfter, 480);
    const pollMs = cfg.intervalMin * 60000;
    if (!cfg.enabled) {
      return { phase: "off", sunriseMin, startMin, stopAfterMin, trMin: tr.min, waitMs: 0 };
    }
    if (tr.min < startMin) {
      return {
        phase: "waiting",
        sunriseMin,
        startMin,
        stopAfterMin,
        trMin: tr.min,
        waitMs: Math.max(5000, Math.min((startMin - tr.min) * 60000, 30 * 60000)),
      };
    }
    if (tr.min >= stopAfterMin && allUnflyable(data)) {
      return {
        phase: "done",
        sunriseMin,
        startMin,
        stopAfterMin,
        trMin: tr.min,
        waitMs: 30 * 60000,
      };
    }
    return {
      phase: "active",
      sunriseMin,
      startMin,
      stopAfterMin,
      trMin: tr.min,
      waitMs: pollMs,
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

  function formatSummary(d) {
    if (!d || !Array.isArray(d.items) || !d.items.length) return "Slot Merkezi durumu güncellendi.";
    return d.items.map(i => {
      const f = FL[i.flag] || ["⚪", i.label || "—"];
      return `${f[0]} ${i.name}: ${f[1]}`;
    }).join(" · ");
  }

  function isNotifEnabled() {
    if (pushOn === true) return true;
    try { return localStorage.getItem(NATIVE_NOTIF_KEY) === "1"; } catch (_) { return false; }
  }

  function notifyChange(d) {
    if (!isNotifEnabled()) return;
    if (typeof AVNOTIF !== "undefined" && typeof AVNOTIF.showSlotAlert === "function") {
      AVNOTIF.showSlotAlert("🚩 AviaDoX · Slot Merkezi Güncellendi", formatSummary(d), false).catch(() => {});
    }
  }

  function scheduleNext() {
    clearTimeout(pollT);
    pollT = null;
    if (!started) return;
    const w = windowState(Date.now());
    if (w.phase === "off" || !w.waitMs) return;
    pollT = setTimeout(() => {
      const cur = windowState(Date.now());
      if (cur.phase === "active") {
        load().catch(() => {}).finally(scheduleNext);
      } else {
        repaint();
        scheduleNext();
      }
    }, w.waitMs);
  }

  const SLOT_SITE_URL = "https://shmkapadokya.kapadokya.edu.tr";
  const METAR_RAW_URL = "https://aviationweather.gov/api/data/metar?ids=LTAZ&format=raw";
  const TAF_RAW_URL = "https://aviationweather.gov/api/data/taf?ids=LTAZ&format=raw";

  function getCapHttp() {
    const C = window.Capacitor;
    if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
    if (C.Plugins && C.Plugins.CapacitorHttp) return C.Plugins.CapacitorHttp;
    if (typeof C.registerPlugin === "function") {
      try { return C.registerPlugin("CapacitorHttp"); } catch (_) {}
    }
    return null;
  }

  async function nativeGetText(url, timeoutMs) {
    const http = getCapHttp();
    if (!http || typeof http.get !== "function") return null;
    const res = await http.get({
      url,
      responseType: "text",
      connectTimeout: timeoutMs || 12000,
      readTimeout: timeoutMs || 15000,
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
    });
    if (!res || (res.status && (res.status < 200 || res.status >= 400))) return null;
    return typeof res.data === "string" ? res.data : (res.data != null ? String(res.data) : null);
  }

  function detectFlag(raw) {
    const s = String(raw || "").toLocaleLowerCase("tr");
    if (/yeşil|yesil|\bgreen\b|uçulabilir|uculabilir|flyable|bg-green|bg-success|text-success|#008000|#2e9e5b|#198754/.test(s)) return "green";
    if (/sarı|sari|\byellow\b|\bamber\b|bg-yellow|bg-warning|text-warning|#ffc107|#f08c00/.test(s)) return "yellow";
    if (/kırmızı|kirmizi|\bred\b|uçulmaz|uculmaz|bg-red|bg-danger|text-danger|#dc3545|#e03131/.test(s)) return "red";
    return null;
  }

  function parseSlotHtml(html) {
    const items = [];
    const seen = new Set();
    const knownRegions = ["Göreme", "Çat", "Soğanlı", "Ihlara", "Avanos", "Ürgüp", "Nevşehir", "Kapadokya"];
    let fullText = "";

    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      fullText = (doc.body && doc.body.textContent ? doc.body.textContent : "").replace(/\s+/g, " ").trim();
      const candidates = Array.from(doc.querySelectorAll("tr, li, article, section, .card, div"))
        .filter(el => {
          const t = (el.textContent || "").trim();
          return t.length >= 3 && t.length <= 450;
        })
        .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);

      for (const el of candidates) {
        const elText = (el.textContent || "").replace(/\s+/g, " ").toLocaleLowerCase("tr");
        for (const reg of knownRegions) {
          if (seen.has(reg)) continue;
          if (elText.includes(reg.toLocaleLowerCase("tr"))) {
            const fl = detectFlag(el.outerHTML);
            if (fl) {
              seen.add(reg);
              items.push({ name: reg, flag: fl, label: (FL[fl] && FL[fl][1]) || "" });
            }
          }
        }
      }
    } catch (_) {
      fullText = String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    if (!items.length) {
      const fallbackFlag = detectFlag(html);
      if (fallbackFlag) {
        items.push({ name: "Kapadokya", flag: fallbackFlag, label: (FL[fallbackFlag] && FL[fallbackFlag][1]) || "" });
      }
    }

    const updMatch = fullText.match(/(?:Güncelleme|Son\s*Güncelleme|Yay[ıi]n\s*Tarihi)\s*[:\-]?\s*([0-9.:\/\-\s]{8,25})/i);
    const valMatch = fullText.match(/(?:Geçerlilik|Geçerli)\s*[:\-]?\s*([0-9.:\/\-\s]{8,35})/i);
    const metarMatch = fullText.match(/\bMETAR\s+LTAZ\s+[A-Z0-9\/\s=+-]{12,180}/);
    const tafMatch = fullText.match(/\bTAF\s+(?:AMD\s+|COR\s+)?LTAZ\s+[A-Z0-9\/\s=+-]{12,260}/);

    return {
      items,
      updated: updMatch ? updMatch[1].trim() : new Date().toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }),
      valid: valMatch ? valMatch[1].trim() : "",
      metar: metarMatch ? metarMatch[0].trim() : "",
      taf: tafMatch ? tafMatch[0].trim() : "",
      tafErr: "",
    };
  }

  async function fetchDirectFromSite() {
    if (!navigator.onLine || !getCapHttp()) return null;
    try {
      const html = await nativeGetText(SLOT_SITE_URL, 15000);
      if (!html) return null;
      const parsed = parseSlotHtml(html);
      if (!parsed.metar) {
        try {
          const m = await nativeGetText(METAR_RAW_URL, 8000);
          if (m && m.trim()) parsed.metar = m.trim();
        } catch (_) {}
      }
      if (!parsed.taf) {
        try {
          const t = await nativeGetText(TAF_RAW_URL, 8000);
          if (t && t.trim()) parsed.taf = t.trim();
        } catch (_) {}
      }
      return parsed.items.length ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  async function load() {
    let nextData = null;
    let nextTs = "";

    // 1) Android/iOS uygulamasının kendi içinden doğrudan resmî Slot Merkezi sayfasını kontrol et
    if (isNative() && navigator.onLine) {
      const direct = await fetchDirectFromSite();
      if (direct && direct.items && direct.items.length) {
        nextData = direct;
        nextTs = new Date().toISOString();
      }
    }

    // 2) Web sürümü veya yedek/METAR-TAF tamamlama için Supabase slot_status kontrolü
    if (canOnline() && (!nextData || !nextData.metar || !nextData.taf)) {
      try {
        const { data: r } = await sb.from("slot_status").select("data,updated_at").eq("id", 1).maybeSingle();
        if (r && r.data) {
          if (!nextData) {
            nextData = r.data;
            nextTs = r.updated_at || "";
          } else {
            if (!nextData.metar && r.data.metar) nextData.metar = r.data.metar;
            if (!nextData.taf && r.data.taf) nextData.taf = r.data.taf;
          }
        }
      } catch (_) {}
    }

    if (nextData) {
      const old = data;
      data = nextData;
      ts = nextTs || new Date().toISOString();
      saveCache();
      if (old && sig(old) !== sig(data)) {
        banner = "🔔 Slot Merkezi güncellendi";
        notifyChange(data);
      }
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
      if (typeof toast === "function") toast("Slot Merkezi kontrol edildi ✔");
    } catch (_) {
      if (typeof toast === "function") toast("Slot Merkezi şu an alınamadı", true);
    }
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
    const onWake = () => {
      const w = windowState(Date.now());
      if (w.phase === "active") load().catch(() => {});
      else { repaint(); scheduleNext(); }
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") onWake();
    });
    window.addEventListener("online", onWake);
    try {
      const C = window.Capacitor;
      const AppPlugin = C && C.isNativePlatform && C.isNativePlatform() && ((C.Plugins && C.Plugins.App) || (C.registerPlugin && C.registerPlugin("App")));
      if (AppPlugin && typeof AppPlugin.addListener === "function") {
        AppPlugin.addListener("appStateChange", st => { if (st && st.isActive) onWake(); });
      }
    } catch (_) {}
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
      try { pushOn = localStorage.getItem(NATIVE_NOTIF_KEY) === "1"; } catch (_) { pushOn = false; }
      repaint();
      return;
    }
    if (s !== "ok") { pushOn = false; return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      pushOn = (!!(await reg.pushManager.getSubscription()) || localStorage.getItem(NATIVE_NOTIF_KEY) === "1") && Notification.permission === "granted";
    } catch (_) { pushOn = false; }
    repaint();
  }
  async function enable() {
    busy = "…"; repaint();
    try {
      if (support() === "native") {
        if (typeof AVNOTIF === "undefined" || typeof AVNOTIF.ensureLocalPermission !== "function") {
          throw new Error("Bildirim modülü hazır değil.");
        }
        const localOk = await AVNOTIF.ensureLocalPermission(true);
        if (!localOk) throw new Error("Bildirim izni verilmedi. Cihaz Ayarları > Bildirimler > AviaDoX bölümünden izin verin.");
        try { localStorage.setItem(NATIVE_NOTIF_KEY, "1"); } catch (_) {}
        pushOn = true;
        // Uzak APNs/FCM varsa sessizce kaydet (yoksa yerel bildirimi engellemez)
        if (typeof AVNOTIF.enablePushNotifications === "function") {
          AVNOTIF.enablePushNotifications().catch(() => {});
        }
        if (typeof AVNOTIF.showSlotAlert === "function") {
          await AVNOTIF.showSlotAlert("🚩 AviaDoX · Slot Merkezi", "Slot Merkezi bildirimleri açıldı ✔", false);
        }
        if (typeof toast === "function") toast("Slot Merkezi bildirimleri açıldı ✔");
      } else {
        if (await Notification.requestPermission() !== "granted") throw new Error("İzin verilmedi. Tarayıcı/telefon ayarlarından bildirimlere izin ver.");
        try { localStorage.setItem(NATIVE_NOTIF_KEY, "1"); } catch (_) {}
        if (canOnline() && typeof AERODOX !== "undefined" && AERODOX.VAPID_PUBLIC) {
          try {
            const reg = await navigator.serviceWorker.ready;
            let sub = await reg.pushManager.getSubscription();
            if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(AERODOX.VAPID_PUBLIC) });
            await sb.from("push_subs").upsert({ user_id: S.user.id, endpoint: sub.endpoint, p256dh: k(sub.getKey("p256dh")), auth: k(sub.getKey("auth")) }, { onConflict: "endpoint" });
          } catch (_) {}
        }
        pushOn = true;
        if (typeof AVNOTIF !== "undefined" && typeof AVNOTIF.showSlotAlert === "function") {
          await AVNOTIF.showSlotAlert("🚩 AviaDoX · Slot Merkezi", "Slot Merkezi bildirimleri açıldı ✔", false);
        }
        if (typeof toast === "function") toast("Slot Merkezi bildirimleri açıldı ✔");
      }
    } catch (e) {
      if (typeof toast === "function") toast("Bildirim açılamadı: " + (e.message || e), true);
      else alert("Bildirim açılamadı: " + (e.message || e));
    }
    busy = ""; repaint();
  }
  async function disable() {
    try { localStorage.setItem(NATIVE_NOTIF_KEY, "0"); } catch (_) {}
    if (support() !== "native") {
      try {
        const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
        if (sub) {
          if (canOnline()) await sb.from("push_subs").delete().eq("endpoint", sub.endpoint);
          await sub.unsubscribe();
        }
      } catch (_) {}
    }
    pushOn = false; repaint();
    if (typeof toast === "function") toast("Slot Merkezi bildirimleri kapatıldı");
  }
  async function testNotif() {
    if (typeof AVNOTIF === "undefined" || typeof AVNOTIF.showSlotAlert !== "function") {
      if (typeof toast === "function") toast("Bildirim modülü yüklenemedi", true);
      return;
    }
    const body = data && data.items && data.items.length
      ? formatSummary(data)
      : "🟢 Göreme: UÇULABİLİR · 🔴 Çat: UÇULMAZ (Test bildirimi)";
    const ok = await AVNOTIF.showSlotAlert("🚩 AviaDoX · Slot Merkezi (Test)", body, true);
    if (ok) {
      try { localStorage.setItem(NATIVE_NOTIF_KEY, "1"); } catch (_) {}
      pushOn = true;
      repaint();
      if (typeof toast === "function") toast("Test bildirimi gönderildi ✔");
    } else {
      if (typeof toast === "function") toast("Bildirim izni verilmedi. Telefon Ayarları > Bildirimler > AviaDoX'u açın.", true);
    }
  }

  function scheduleStatusLine() {
    const w = windowState(Date.now());
    const sr = fmtHM(w.sunriseMin);
    const st = fmtHM(w.startMin);
    let statusText;
    if (w.phase === "off") statusText = "⚪ Otomatik kontrol kapalı (Ayarlar'dan açılabilir)";
    else if (w.phase === "active") statusText = `🟢 Otomatik kontrol aktif (her ${cfg.intervalMin} dk)`;
    else if (w.phase === "waiting") statusText = `⏳ Otomatik kontrol beklemede (${st}'de başlar · ${cfg.intervalMin} dk aralık)`;
    else statusText = `⏹ Otomatik kontrol durdu (${cfg.stopAfter} sonrası tüm bölgeler Uçulmaz)`;
    return `☀️ Kapadokya gün doğumu: <b>${sr}</b> · Başlangıç: <b>${st}</b><br>${statusText}`;
  }

  function settingsCard() {
    const w = windowState(Date.now());
    const sr = fmtHM(w.sunriseMin);
    const st = fmtHM(w.startMin);
    return `<div class="card" id="slot-cfg-card"><b>🚩 Slot Merkezi Kontrolü ve Bildirim</b>
<div class="mu" style="margin:4px 0 10px">Kapadokya gün doğumundan önce belirlediğiniz dakikada başlar, seçtiğiniz aralıkta kontrol eder ve bitiş saatinden sonra tüm bölgeler Uçulmaz olunca otomatik durur.</div>
<label style="display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;margin-bottom:10px;cursor:pointer">
  <input id="sl-en" type="checkbox" ${cfg.enabled ? "checked" : ""} style="width:auto;margin:0;padding:0;transform:scale(1.2)">
  <span>Otomatik Slot kontrolü açık</span>
</label>
<div class="grid" style="margin-bottom:4px">
  <div><label class="mu">Kontrol süresi (dk)</label><input id="sl-int" type="number" min="1" max="30" inputmode="numeric" value="${cfg.intervalMin}"></div>
  <div><label class="mu">Gün doğumundan önce (dk)</label><input id="sl-pre" type="number" min="0" max="180" inputmode="numeric" value="${cfg.preSunriseMin}"></div>
</div>
<label class="mu">Bitiş kontrol saati (TR — tüm bölgeler Uçulmaz olunca dur)</label>
<input id="sl-stop" type="time" value="${esc(cfg.stopAfter)}">
<div class="mu" style="margin:2px 0 10px;padding:8px 10px;border-radius:8px;background:var(--bg)">${scheduleStatusLine()}</div>
<button onclick="SLOT.saveSettings()">Kaydet</button>
<div style="display:flex;gap:8px;flex-wrap:wrap">
  <button class="sec" style="flex:1;min-width:140px" onclick="SLOT.testNotif()">🔔 Test Bildirimi</button>
  <button class="sec" style="flex:1;min-width:140px" onclick="SLOT.refresh()">↻ Şimdi Kontrol Et</button>
</div>
<div class="mu" style="margin-top:4px">Gün doğumu (${sr}) − ${cfg.preSunriseMin} dk = ${st} başlangıç · ${cfg.stopAfter} sonrası tüm bölgeler Uçulmaz olana kadar her ${cfg.intervalMin} dk.</div>
</div>`;
  }

  function saveSettings() {
    const enEl = document.getElementById("sl-en");
    const intEl = document.getElementById("sl-int");
    const preEl = document.getElementById("sl-pre");
    const stopEl = document.getElementById("sl-stop");
    if (!enEl || !intEl || !preEl || !stopEl) return;
    saveCfg({
      enabled: !!enEl.checked,
      intervalMin: Number(intEl.value),
      preSunriseMin: Number(preEl.value),
      stopAfter: stopEl.value,
    });
    if (cfg.enabled && windowState(Date.now()).phase === "active") {
      load().catch(() => {});
    }
    if (typeof render === "function") render();
    if (typeof toast === "function") {
      toast(cfg.enabled ? `Slot kontrolü kaydedildi (her ${cfg.intervalMin} dk)` : "Otomatik Slot kontrolü kapatıldı");
    }
  }

  function pushCard() {
    const s = support();
    let t;
    if (s === "ok" || s === "native") {
      t = pushOn
        ? `<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="sec" style="width:auto;margin:0;padding:8px 12px" onclick="SLOT.testNotif()">🔔 Test</button><button class="sec" style="width:auto;margin:0;padding:8px 12px" onclick="SLOT.off()">🔕 Kapat</button></div>`
        : `<button style="width:auto;margin:0" onclick="SLOT.on()">🔔 Bildirimleri aç ${esc(busy)}</button>`;
    } else if (s === "ios") {
      t = '<span class="mu">iPhone\'da bildirim için uygulamayı Safari ▸ Paylaş ▸ <b>Ana Ekrana Ekle</b> ile ekleyip ana ekran simgesinden aç (iOS 16.4+), sonra bu butonu kullan.</span>';
    } else {
      t = '<span class="mu">Bu tarayıcı bildirimi desteklemiyor.</span>';
    }
    return `<div class="card" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:150px"><b>Bildirim</b><div class="mu">Slot kararı değiştiğinde telefon bildirimi gönder</div></div>${t}</div>`;
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
    return `<div class="mu" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bd);display:flex;justify-content:space-between;align-items:flex-end;gap:8px;flex-wrap:wrap"><div>${scheduleStatusLine()}</div><button class="sec" style="width:auto;margin:0;padding:5px 10px;font-size:12px" onclick="S.tab='ak';render()">⚙️ Süre / Ayarlar</button></div>`;
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
    testNotif,
    settingsCard,
    saveSettings,
    saveCfg,
    getConfig: () => ({ ...cfg }),
    scheduleStatusLine,
    isNotifOn: isNotifEnabled,
    metarCard,
    windowState,
    get data() { return data; },
  };
})();
