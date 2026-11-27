// Slot Merkezi sekmesi + Ayarlar'dan yönetilebilen Kapadokya gün doğumu bazlı otomatik kontrol + gerçek yerel/push bildirim + METAR/TAF kartı.
const SLOT = (() => {
  const CACHE_KEY = "aviadox-slot-cache-v2";
  const LAST_SIG_KEY = "aviadox-slot-last-sig-v2";
  const CFG_KEY = "aviadox-slot-cfg-v1";
  const NATIVE_NOTIF_KEY = "aviadox-native-slot-push";
  const CAP_LAT = 38.7235072; // Resmî Slot Merkezi Kapadokya koordinatı
  const CAP_LON = 34.7194168;
  const TR_TZ_MIN = 180;      // Türkiye sabit UTC+3

  const DEFAULT_CFG = {
    enabled: true,
    intervalMin: 2,
    preSunriseMin: 45,
    stopAfter: "08:00",
  };

  let cfg = loadCfg();
  let data = null, ts = "", host = null, started = false, ch = null, banner = "", fetchErr = "", pushOn = null, busy = "", pollT = null, staleTickT = null, refreshing = false;
  const FL = { red: ["🔴", "UÇULMAZ", "var(--er)"], yellow: ["🟡", "UÇULMAZ (sarı bayrak)", "var(--wa)"], green: ["🟢", "UÇULABİLİR", "var(--ok,#2e9e5b)"] };
  const sig = d => JSON.stringify((d && Array.isArray(d.items) ? d.items : []).map(i => `${i.name}:${i.flag}:${i.valid || ""}`));
  const tm = s => s ? new Date(s).toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "";
  function elapsedText(isoTs) {
    if (!isoTs) return "";
    const ms = Date.now() - new Date(isoTs).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "Veriler az önce güncellendi";
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "Veriler az önce güncellendi";
    if (mins < 60) return `Veriler ${mins}dk önce güncellendi`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hrs < 24) return rem ? `Veriler ${hrs}sa ${rem}dk önce güncellendi` : `Veriler ${hrs}sa önce güncellendi`;
    return `Veriler ${Math.floor(hrs / 24)} gün önce güncellendi`;
  }
  function loadLastSig() { try { return localStorage.getItem(LAST_SIG_KEY) || ""; } catch (_) { return ""; } }
  function saveLastSig(v) { try { if (v) localStorage.setItem(LAST_SIG_KEY, v); } catch (_) {} }
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

  const SLOT_SITE_URL = "https://shmkapadokya.kapadokya.edu.tr/";
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

  async function nativeGetText(url, timeoutMs, bustCache) {
    const http = getCapHttp();
    if (!http || typeof http.get !== "function") return null;
    const reqUrl = bustCache ? `${url}${url.includes("?") ? "&" : "?"}_t=${Date.now()}` : url;
    const res = await http.get({
      url: reqUrl,
      responseType: "text",
      connectTimeout: timeoutMs || 12000,
      readTimeout: timeoutMs || 15000,
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
    });
    if (!res || (res.status && (res.status < 200 || res.status >= 400))) return null;
    return typeof res.data === "string" ? res.data : (res.data != null ? String(res.data) : null);
  }

  function flagFromImg(src) {
    const s = String(src || "").toLowerCase();
    if (!s) return null;
    if (/red|kirmizi/.test(s)) return "red";
    if (/yellow|sari|orange|amber/.test(s)) return "yellow";
    if (/green|yesil/.test(s)) return "green";
    return null;
  }

  function flagFromTitle(title) {
    const s = String(title || "").toLocaleLowerCase("tr");
    if (!s) return null;
    // Havacılık güvenliği (fail-safe): olumsuz karar her zaman olumludan önce değerlendirilir
    if (/uçul(?:a)?maz|ucul(?:a)?maz|iptal|kırmızı|kirmizi/.test(s)) return "red";
    if (/sarı|sari|bekle|kısıtlı|kisitli/.test(s)) return "yellow";
    if (/uçulabilir|uculabilir|yeşil|yesil/.test(s)) return "green";
    return null;
  }

  function reconcileFlag(imgFlag, titleFlag) {
    if (imgFlag && titleFlag) {
      if (imgFlag === titleFlag) return imgFlag;
      // Bayrak görseli ile başlık çelişirse asla yeşil (Uçulabilir) üretme
      if (imgFlag === "red" || titleFlag === "red") return "red";
      return "yellow";
    }
    return imgFlag || titleFlag || null;
  }

  function formatSectorName(raw) {
    const cleaned = String(raw || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s+(?:U[CÇ]UL(?:A)?MAZ|U[CÇ]ULAB[İI]L[İI]R|KIRMIZI(?:\s+BAYRAK)?|SARI(?:\s+BAYRAK)?|YE[SŞ][İI]L(?:\s+BAYRAK)?|[İI]PTAL)\b.*$/i, "")
      .trim();
    if (!cleaned) return "";
    const m = /^SEKT[ÖO]R\s+([A-ZÇĞİÖŞÜ0-9]+)$/i.exec(cleaned);
    if (m) return "Sektör " + m[1].toLocaleUpperCase("tr");
    return cleaned;
  }

  function isHiddenEl(el) {
    if (!el) return true;
    if (el.hasAttribute && el.hasAttribute("hidden")) return true;
    const cls = (el.getAttribute && el.getAttribute("class")) || "";
    if (/\bd-none\b|\bhidden\b/i.test(cls)) return true;
    const st = (el.getAttribute && el.getAttribute("style")) || "";
    if (/display\s*:\s*none/i.test(st) || /visibility\s*:\s*hidden/i.test(st)) return true;
    return false;
  }

  function stripHtmlText(s) {
    return String(s || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseSectorBlocksRegex(html) {
    const items = [];
    const parts = String(html || "").split(/<div[^>]*class="[^"]*\bsector-div\b[^"]*"[^>]*>/i).slice(1);
    for (const rawPart of parts) {
      const block = rawPart.split(/<div[^>]*id="Sektorler"/i)[0];
      const h3m = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      const titleRaw = h3m ? stripHtmlText(h3m[1]) : "";
      const imgm = block.match(/<img[^>]*src=["']([^"']*flags\/[^"']+)["']/i);
      const fl = reconcileFlag(flagFromImg(imgm ? imgm[1] : ""), flagFromTitle(titleRaw));
      if (!fl) continue;
      const name = formatSectorName(titleRaw) || `Sektör ${items.length + 1}`;
      let desc = "";
      const pMatches = block.matchAll(/<p([^>]*)class="[^"]*\bsector-text\b[^"]*"([^>]*)>([\s\S]*?)<\/p>/gi);
      for (const pm of pMatches) {
        const attrs = (pm[1] || "") + " " + (pm[2] || "");
        if (/display\s*:\s*none/i.test(attrs) || /\bhidden\b/i.test(attrs)) continue;
        const txt = stripHtmlText(pm[3]);
        if (txt) { desc = txt; break; }
      }
      const h4s = [...block.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/gi)].map(m => stripHtmlText(m[1]));
      let updated = "", valid = "";
      for (let i = 0; i < h4s.length - 1; i++) {
        const k = h4s[i].toLocaleLowerCase("tr");
        if (k.includes("güncelleme") && !updated) updated = h4s[i + 1];
        else if (k.includes("geçerli") && !valid) valid = h4s[i + 1];
      }
      items.push({ name, flag: fl, label: (FL[fl] && FL[fl][1]) || "", desc, updated, valid });
    }
    return items;
  }

  function parseSlotHtml(html) {
    if (!html || typeof html !== "string") return null;
    const items = [];
    let metar = "";
    let taf = "";
    let fullText = "";

    if (typeof DOMParser !== "undefined") {
      try {
        const doc = new DOMParser().parseFromString(html, "text/html");
        fullText = (doc.body && doc.body.textContent ? doc.body.textContent : "").replace(/\s+/g, " ").trim();

        const sectorEls = Array.from(doc.querySelectorAll(".sector-div"));
        for (const sec of sectorEls) {
          const h3 = sec.querySelector("h3");
          const titleRaw = h3 ? (h3.textContent || "").replace(/\s+/g, " ").trim() : "";
          const flagImg = sec.querySelector('img[src*="flags/"]') || sec.querySelector(".icon img");
          const imgSrc = flagImg ? (flagImg.getAttribute("src") || "") : "";

          const fl = reconcileFlag(flagFromImg(imgSrc), flagFromTitle(titleRaw));
          if (!fl) continue;

          const name = formatSectorName(titleRaw) || `Sektör ${items.length + 1}`;

          let desc = "";
          const pEls = Array.from(sec.querySelectorAll("p.sector-text, p"));
          for (const p of pEls) {
            if (isHiddenEl(p)) continue;
            const t = (p.textContent || "").replace(/\s+/g, " ").trim();
            if (t) { desc = t; break; }
          }

          let updated = "", valid = "";
          const h4s = Array.from(sec.querySelectorAll(".sector-bottom-list h4, h4"))
            .map(h => (h.textContent || "").replace(/\s+/g, " ").trim());
          for (let i = 0; i < h4s.length - 1; i++) {
            const k = h4s[i].toLocaleLowerCase("tr");
            if (k.includes("güncelleme") && !updated) updated = h4s[i + 1];
            else if (k.includes("geçerli") && !valid) valid = h4s[i + 1];
          }

          items.push({ name, flag: fl, label: (FL[fl] && FL[fl][1]) || "", desc, updated, valid });
        }

        // Resmî sayfadaki HEZARFEN Rasat METAR / TAF blokları (başlık sayfada "TAFF" olarak da geçebiliyor)
        const blocks = Array.from(doc.querySelectorAll(".bottom-block"));
        for (const blk of blocks) {
          const head = ((blk.querySelector(".bottom-head, h3, h4") || {}).textContent || "").trim().toUpperCase();
          const body = ((blk.querySelector(".bottom-text, p") || {}).textContent || "").replace(/\s+/g, " ").trim();
          if (!body) continue;
          if (!metar && (head.includes("METAR") || /^METAR\s+LTAZ\b/i.test(body))) metar = body;
          else if (!taf && (head.includes("TAF") || /^TAF\s+/i.test(body))) taf = body;
        }
      } catch (_) {}
    }

    if (!items.length) {
      items.push(...parseSectorBlocksRegex(html));
    }

    // KRİTİK EMNİYET KURALI: Geçerli .sector-div blokları bulunamadıysa ham sayfadan asla bayrak tahmin etme!
    if (!items.length) return null;

    if (!fullText) fullText = stripHtmlText(html);
    if (!metar) {
      const metarMatch = fullText.match(/\bMETAR\s+LTAZ\s+[A-Z0-9\/\s=+-]{12,180}/);
      if (metarMatch) metar = metarMatch[0].trim();
    }
    if (!taf) {
      const tafMatch = fullText.match(/\bTAF\s+(?:AMD\s+|COR\s+)?LTAZ\s+[A-Z0-9\/\s=+-]{12,260}/);
      if (tafMatch) taf = tafMatch[0].trim();
    }

    const firstUpd = (items.find(i => i.updated) || {}).updated || "";
    const firstVal = (items.find(i => i.valid) || {}).valid || "";

    return {
      items,
      updated: firstUpd || new Date().toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }),
      valid: firstVal,
      metar,
      taf,
      tafErr: "",
      source: "direct",
    };
  }

  async function fetchDirectFromSite() {
    if (!navigator.onLine || !getCapHttp()) return null;
    try {
      const html = await nativeGetText(SLOT_SITE_URL, 15000, true);
      if (!html) return null;
      const parsed = parseSlotHtml(html);
      if (!parsed || !parsed.items || !parsed.items.length) return null;
      if (!parsed.metar) {
        try {
          const m = await nativeGetText(METAR_RAW_URL, 8000, false);
          if (m && m.trim()) parsed.metar = m.trim();
        } catch (_) {}
      }
      if (!parsed.taf) {
        try {
          const t = await nativeGetText(TAF_RAW_URL, 8000, false);
          if (t && t.trim()) parsed.taf = t.trim();
        } catch (_) {}
      }
      return parsed;
    } catch (_) {
      return null;
    }
  }

  async function load() {
    let nextData = null;
    let nextTs = "";
    let directTried = false;

    // 1) Android/iOS uygulamasında doğrudan resmî Slot Merkezi sayfasından önbelleksiz oku
    if (isNative() && navigator.onLine) {
      directTried = true;
      const direct = await fetchDirectFromSite();
      if (direct && direct.items && direct.items.length) {
        nextData = direct;
        nextTs = new Date().toISOString();
      }
    }

    // 2) Web sürümü (CORS nedeniyle) veya ilk açılışta doğrudan erişim yoksa Supabase yedeğini kontrol et
    if (canOnline() && (!isNative() || (!nextData && !data) || (nextData && (!nextData.metar || !nextData.taf)))) {
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

    if (nextData && Array.isArray(nextData.items) && nextData.items.length) {
      const prevSig = data ? sig(data) : loadLastSig();
      const nextSig = sig(nextData);
      const isFallback = directTried && nextData.source !== "direct";
      data = nextData;
      ts = nextTs || new Date().toISOString();
      fetchErr = isFallback
        ? "Resmî Slot Merkezi'ne şu an ulaşılamadı — son alınan yedek veri gösteriliyor."
        : "";
      saveCache();
      if (!isFallback) {
        saveLastSig(nextSig);
        // Bildirimi YALNIZCA sektör bayrak/geçerlilik verisi gerçekten değiştiğinde gönder
        if (prevSig && prevSig !== nextSig) {
          banner = "🔔 Slot Merkezi güncellendi";
          notifyChange(data);
        }
      }
      syncStaleTicker();
      repaint();
      scheduleNext();
      return !fetchErr;
    }

    fetchErr = navigator.onLine
      ? "Resmî Slot Merkezi'ne şu an ulaşılamadı veya bayrak bilgisi okunamadı — son başarılı veri gösteriliyor."
      : "İnternet bağlantısı yok — son başarılı veri gösteriliyor.";
    syncStaleTicker();
    repaint();
    scheduleNext();
    return false;
  }
  function syncStaleTicker() {
    clearInterval(staleTickT);
    staleTickT = null;
    if (fetchErr && data && ts) {
      staleTickT = setInterval(() => {
        if (host && host.isConnected) repaint();
      }, 60000);
    }
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    repaint();
    try {
      const ok = await load();
      if (typeof toast === "function") {
        if (ok) toast("Slot Merkezi güncellendi ✔");
        else {
          const ago = elapsedText(ts);
          toast(data ? `${ago || "Eski veri gösteriliyor"} (yeni veri alınamadı)` : "Slot Merkezi şu an alınamadı", true);
        }
      }
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
      : "🔴 Sektör A: UÇULMAZ · 🔴 Sektör B: UÇULMAZ · 🔴 Sektör C: UÇULMAZ (Test bildirimi)";
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
    if (!data || !data.items || !data.items.length) {
      return '<div class="card"><p class="mu" style="margin:0">Resmî Slot Merkezi verisi bekleniyor… Yenile düğmesine basarak kontrol edebilirsiniz.</p></div>';
    }
    return data.items.map(i => {
      const f = FL[i.flag] || ["⚪", i.label || "—", "var(--mu)"];
      const valLine = i.valid || data.valid || "";
      const updLine = i.updated || data.updated || "";
      return `<div class="card" style="border-left:4px solid ${f[2]}">
<div class="row" style="align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
  <div style="font-size:16px;font-weight:700">${f[0]} ${esc(i.name)}</div>
  <span style="font-size:12px;font-weight:700;color:${f[2]};padding:3px 8px;border-radius:6px;background:var(--bg)">${esc(f[1])}</span>
</div>
${valLine ? `<div class="mu" style="margin-top:6px;font-size:13px">🕒 Geçerli: <b>${esc(valLine)}</b>${updLine ? ` · Güncelleme: ${esc(updLine)}` : ""}</div>` : ""}
${i.desc ? `<div style="margin-top:6px;font-size:13px;line-height:1.45">${esc(i.desc)}</div>` : ""}
</div>`;
    }).join("");
  }
  function metarCard() {
    if (!data) return "";
    const taf = data.taf ? esc(data.taf) : `<span class="mu">TAF şu an alınamadı${data.tafErr ? " (kaynak: " + esc(data.tafErr.slice(0, 80)) + ")" : ""}.</span>`;
    return `<h2>METAR / TAF (LTAZ)</h2><div class="card"><div class="mu">METAR</div><div style="font-family:monospace;word-break:break-word">${esc(data.metar || "—")}</div><div class="mu" style="margin-top:10px">TAF</div><div style="font-family:monospace;word-break:break-word">${taf}</div><div class="mu" style="margin-top:8px">Kaynak: Slot Merkezi sayfası (HEZARFEN Rasat)</div></div>`;
  }
  function scheduleInfoHtml() {
    return `<div class="mu" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bd);display:flex;justify-content:space-between;align-items:flex-end;gap:8px;flex-wrap:wrap"><div>${scheduleStatusLine()}</div><button class="sec" style="width:auto;margin:0;padding:5px 10px;font-size:12px" onclick="S.tab='ak';render()">⚙️ Süre / Ayarlar</button></div>`;
  }
  function staleWarnHtml() {
    if (!fetchErr) return "";
    const ago = data && ts ? elapsedText(ts) : "";
    const title = ago ? `⚠️ ${ago}` : `⚠️ ${fetchErr}`;
    const meta = (data && data.updated)
      ? `Resmî güncelleme: ${esc(data.updated)}${ts ? " · Son kontrol: " + esc(tm(ts)) : ""}`
      : (ts ? `Son kontrol: ${esc(tm(ts))}` : "");
    return `<div class="card" style="border-color:var(--wa);background:rgba(245,158,11,.12)"><b>${esc(title)}</b><div class="mu" style="margin-top:4px">${ago ? esc(fetchErr) : "Güncel bilgi alınamadı; lütfen resmî sayfayı kontrol edin."}${meta ? "<br>" + meta : ""}</div></div>`;
  }
  function view() {
    const d = data || {};
    return `${banner ? `<div class="card" style="border-color:var(--pr)"><b>${esc(banner)}</b></div>` : ""}${staleWarnHtml()}<div class="card"><div class="row" style="align-items:flex-start"><div style="flex:1;min-width:0"><b>Kapadokya Slot Merkezi</b><div class="mu">${d.updated ? "Güncelleme: " + esc(d.updated) : "Henüz veri yok"}${d.valid ? "<br>Geçerli: " + esc(d.valid) : ""}</div></div><button class="sec" style="width:auto;margin:0;padding:6px 10px;font-size:13px" onclick="SLOT.refresh()" ${refreshing ? "disabled" : ""}>${refreshing ? "…" : "↻ Yenile"}</button></div>${scheduleInfoHtml()}</div>${flagCards()}${pushCard()}<p class="mu" style="margin-top:10px">Kırmızı/sarı bayrak: kalkış izni verilmez. Yeşilde nihai uçuş kararı pilot ve işletmeye aittir. Bilgi resmî sayfadan otomatik alınır ve gecikebilir; resmî kaynağı esas alın. <a href="https://shmkapadokya.kapadokya.edu.tr" target="_blank" rel="noopener noreferrer" onclick="if(typeof openExternalUrl==='function'){openExternalUrl(this.href);return false;}">Slot Merkezi sayfası ↗</a>${ts ? " · Son kontrol: " + esc(tm(ts)) : ""}</p>`;
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
    elapsedText,
    _parseSlotHtml: parseSlotHtml,
    get data() { return data; },
  };
})();
