/* ===== AviaDoX Bildirim Merkezi (Kilit Ekranı GPX + NOTAM + Slot Push + Evrak/Bakım Hatırlatmaları) =====
 * Tasarım ilkesi:
 *  - Her bildirim türü ayrı ID aralığı ve ayrı iOS threadIdentifier / Android channel kullanır.
 *  - GPX kaydı durduğunda YALNIZCA 9001 (ve varsa 9002 NOTAM) temizlenir; Slot Merkezi veya diğer
 *    uygulama bildirimleri (Push / Evrak / Bakım) ASLA silinmez.
 *  - index.html içinde app.js ve flightlog.js'den ÖNCE yüklenmesi önerilir:
 *      <script src="notifications.js"></script>
 */
const AVNOTIF = (() => {
  "use strict";

  const IDS = {
    GPX: 9001,
    NOTAM: 9002,
    SLOT: 9003,
    REMINDER_MIN: 9100,
    REMINDER_MAX: 9199,
  };

  const CHANNELS = [
    {
      id: "aviadox_gpx",
      name: "GPX Uçuş Kaydı",
      description: "Kilit ekranında aktif GPX uçuş kaydı durum bildirimi",
      importance: 2, // LOW: sessiz kalıcı durum bildirimi
      visibility: 1, // PUBLIC: kilit ekranında görünsün
      sound: "",
      vibration: false,
    },
    {
      id: "aviadox_notam",
      name: "NOTAM Saha Uyarıları",
      description: "Kısıtlı NOTAM sahasına yaklaşma veya giriş uyarıları",
      importance: 5, // MAX: sesli acil uyarı
      visibility: 1,
      vibration: true,
    },
    {
      id: "aviadox_reminders",
      name: "Evrak ve Bakım Hatırlatmaları",
      description: "Süresi yaklaşan balon bakımları ve personel/işletme evrakları",
      importance: 4,
      visibility: 1,
      vibration: true,
    },
    {
      id: "aviadox_slot",
      name: "Slot Merkezi ve Duyurular",
      description: "Slot kararı güncellemeleri ve diğer uygulama bildirimleri",
      importance: 4,
      visibility: 1,
      vibration: true,
    },
  ];

  const state = {
    ready: false,
    channelsDone: false,
    localPerm: "prompt",
    pushPerm: "prompt",
    pushToken: null,
    liveActive: false,
    gpxVisible: false,
    lastGpxUpdate: 0,
    pushListeners: [],
    tokenListeners: [],
    tapHandler: null,
  };

  function getPlugin(name) {
    try {
      const C = window.Capacitor;
      if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
      return (C.Plugins && C.Plugins[name]) || (C.registerPlugin ? C.registerPlugin(name) : null);
    } catch (_) {
      return null;
    }
  }

  const LN = () => getPlugin("LocalNotifications");
  const PN = () => getPlugin("PushNotifications");
  const LA = () => {
    try {
      const C = window.Capacitor;
      return C && C.Plugins && C.Plugins.FlightLiveActivity ? C.Plugins.FlightLiveActivity : null;
    } catch (_) {
      return null;
    }
  };

  const fmtDur = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  };

  async function ensureChannels() {
    if (state.channelsDone) return;
    const ln = LN();
    if (!ln || typeof ln.createChannel !== "function") return;
    state.channelsDone = true;
    for (const ch of CHANNELS) {
      try {
        await ln.createChannel(ch);
      } catch (_) {}
    }
  }

  async function ensureLocalPermission(ask) {
    const ln = LN();
    if (ln) {
      try {
        let perm = await ln.checkPermissions();
        if (perm && perm.display !== "granted" && ask) {
          perm = await ln.requestPermissions();
        }
        state.localPerm = (perm && perm.display) || "denied";
        if (state.localPerm === "granted") await ensureChannels();
        return state.localPerm === "granted";
      } catch (_) {
        return false;
      }
    }
    if (typeof Notification !== "undefined") {
      if (Notification.permission === "granted") return true;
      if (ask && Notification.permission === "default") {
        try {
          const r = await Notification.requestPermission();
          return r === "granted";
        } catch (_) {
          return false;
        }
      }
    }
    return false;
  }

  function routeTap(extra) {
    const targetTab = (extra && extra.tab) || (extra && extra.type === "slot" ? "sm" : null);
    if (state.tapHandler && targetTab) {
      try {
        state.tapHandler(targetTab, extra || {});
      } catch (_) {}
      return;
    }
    try {
      window.dispatchEvent(new CustomEvent("aviadox:notification-tap", { detail: extra || {} }));
    } catch (_) {}
  }

  async function init(opts) {
    if (opts && typeof opts.onTap === "function") state.tapHandler = opts.onTap;
    if (state.ready) return;
    state.ready = true;

    const ln = LN();
    if (ln) {
      await ensureChannels();
      try {
        ln.addListener("localNotificationActionPerformed", (ev) => {
          const extra = ev && ev.notification && ev.notification.extra ? ev.notification.extra : {};
          routeTap(extra);
        });
      } catch (_) {}
    }

    const pn = PN();
    if (pn) {
      try {
        pn.addListener("registration", (token) => {
          state.pushToken = token && token.value ? token.value : null;
          if (state.pushToken) {
            try {
              localStorage.setItem("aviadox-push-token", state.pushToken);
            } catch (_) {}
            state.tokenListeners.forEach((fn) => {
              try {
                fn(state.pushToken);
              } catch (_) {}
            });
            try {
              window.dispatchEvent(
                new CustomEvent("aviadox:push-token", { detail: { token: state.pushToken } })
              );
            } catch (_) {}
          }
        });
        pn.addListener("pushNotificationReceived", (notif) => {
          state.pushListeners.forEach((fn) => {
            try {
              fn(notif);
            } catch (_) {}
          });
          try {
            window.dispatchEvent(new CustomEvent("aviadox:push-received", { detail: notif }));
          } catch (_) {}
        });
        pn.addListener("pushNotificationActionPerformed", (ev) => {
          const data = (ev && ev.notification && ev.notification.data) || {};
          routeTap({ tab: data.tab || "sm", type: data.type || "push", ...data });
        });

        const perm = await pn.checkPermissions();
        state.pushPerm = (perm && perm.receive) || "prompt";
        const plat = window.Capacitor && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : "";
        // Android'de google-services.json yoksa otomatik pn.register() Firebase hatasıyla uygulamayı kapatabilir;
        // iOS'ta APNs doğrudan hazırdır, Android'de yalnızca kullanıcı Slot bildirimini açtığında denenir.
        if (state.pushPerm === "granted" && plat === "ios") {
          await pn.register().catch(() => {});
        }
      } catch (_) {}
    }
  }

  async function enablePushNotifications() {
    const pn = PN();
    if (!pn) return { ok: false, reason: "web" };
    try {
      let perm = await pn.checkPermissions();
      if (perm && perm.receive !== "granted") {
        perm = await pn.requestPermissions();
      }
      state.pushPerm = (perm && perm.receive) || "denied";
      if (state.pushPerm !== "granted") return { ok: false, reason: "denied" };
      await pn.register();
      return { ok: true, token: state.pushToken };
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : "error" };
    }
  }

  /* ---------- 1. Kilit Ekranı GPX Kayıt Bildirimi (ID: 9001 + Opsiyonel iOS Live Activity) ---------- */
  async function showGpxStatus(info, askPerm) {
    const dur = fmtDur(Math.max(0, (info.now || Date.now()) - (info.startedAt || Date.now())));
    const altStr = info.alt != null && isFinite(info.alt) ? `${Math.round(info.alt)} m` : "– m";
    const gsStr = info.gs != null && isFinite(info.gs) ? `${(info.gs * 3.6).toFixed(0)} km/sa` : "0 km/sa";
    const hasCourse = info.course != null && isFinite(info.course) && info.course >= 0;
    const hdgDeg = hasCourse ? ((Math.round(info.course) % 360) + 360) % 360 : null;
    const hdgStr = hdgDeg != null ? `${String(hdgDeg).padStart(3, "0")}°` : "–°";
    const call = info.callsign ? `${info.callsign} · ` : "";
    const simTag = info.sim ? " [TEST]" : "";

    const title = `🔴 AviaDoX · GPX Kaydı Aktif${simTag}`;
    const body = `${call}${dur} · ${altStr} · ${gsStr} · ${hdgStr}`;

    // A) iOS 16.2+ Live Activity (Xcode'da FlightLiveActivity.swift eklendiyse)
    const la = LA();
    if (la) {
      const payload = {
        callsign: info.callsign || "AviaDoX",
        startedAt: info.startedAt || Date.now(),
        duration: dur,
        altitudeM: info.alt != null && isFinite(info.alt) ? Math.round(info.alt) : 0,
        speedKmh: info.gs != null && isFinite(info.gs) ? Math.round(info.gs * 3.6) : 0,
        headingDeg: hdgDeg != null ? hdgDeg : -1,
        sim: !!info.sim,
      };
      try {
        if (!state.liveActive && typeof la.start === "function") {
          await la.start(payload);
          state.liveActive = true;
        } else if (typeof la.update === "function") {
          await la.update(payload);
        }
      } catch (_) {}
    }

    // B) iOS & Android Kilit Ekranı Yerel Bildirimi (ID 9001 — her zaman aynı ID güncellenir, spam yapmaz)
    const ok = await ensureLocalPermission(!!askPerm);
    if (!ok) return false;

    const ln = LN();
    if (ln) {
      try {
        await ln.schedule({
          notifications: [
            {
              id: IDS.GPX,
              title,
              body,
              channelId: "aviadox_gpx",
              threadIdentifier: "aviadox-gpx",
              ongoing: true,
              autoCancel: false,
              silent: true,
              extra: { tab: "fl", type: "gpx" },
            },
          ],
        });
        state.gpxVisible = true;
        state.lastGpxUpdate = Date.now();
        return true;
      } catch (_) {
        return false;
      }
    }

    // C) Web tarayıcı yedeği (tag ile tek bildirimde güncellenir)
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(title, { body, tag: "aviadox-gpx", silent: true });
        state.gpxVisible = true;
        state.lastGpxUpdate = Date.now();
        return true;
      } catch (_) {}
    }
    return false;
  }

  async function clearGpxStatus() {
    const la = LA();
    if (la && state.liveActive && typeof la.stop === "function") {
      try {
        await la.stop();
      } catch (_) {}
      state.liveActive = false;
    }

    const ln = LN();
    state.gpxVisible = false;
    if (!ln) return;

    // KRİTİK: Sadece GPX (9001) ve NOTAM (9002) temizlenir; diğer uygulama bildirimleri korunur!
    const targets = [{ id: IDS.GPX }, { id: IDS.NOTAM }];
    try {
      await ln.cancel({ notifications: targets });
    } catch (_) {}
    try {
      if (typeof ln.removeDeliveredNotifications === "function") {
        await ln.removeDeliveredNotifications({
          notifications: targets.map((t) => ({ id: t.id, tag: "" })),
        });
      }
    } catch (_) {}
  }

  /* ---------- 2. Kilit Ekranı NOTAM İhlal / Yaklaşma Uyarısı (ID: 9002) ---------- */
  async function showNotamAlert(level, zoneName, distanceM) {
    const ok = await ensureLocalPermission(false);
    if (!ok) return;
    const title =
      level === "inside"
        ? `⚠️ NOTAM Sahası İçindesiniz`
        : `⚠️ NOTAM Sınırına Yaklaşıldı`;
    const body =
      level === "inside"
        ? `${zoneName} kısıtlı sahası içindesiniz. Rotanızı kontrol edin.`
        : `${zoneName} sınırına ${Math.round(distanceM || 0)} m kaldı.`;

    const ln = LN();
    if (ln) {
      try {
        await ln.schedule({
          notifications: [
            {
              id: IDS.NOTAM,
              title,
              body,
              channelId: "aviadox_notam",
              threadIdentifier: "aviadox-notam",
              extra: { tab: "fl", type: "notam" },
            },
          ],
        });
      } catch (_) {}
    }
  }

  /* ---------- 2b. Slot Merkezi Durum Değişikliği / Test Bildirimi (ID: 9003) ---------- */
  async function showSlotAlert(title, body, askPerm) {
    const ok = await ensureLocalPermission(!!askPerm);
    if (!ok) return false;
    const ttl = title || "🚩 AviaDoX · Slot Merkezi";
    const msg = body || "Slot Merkezi durumu güncellendi.";

    const ln = LN();
    if (ln) {
      try {
        await ln.schedule({
          notifications: [
            {
              id: IDS.SLOT,
              title: ttl,
              body: msg,
              channelId: "aviadox_slot",
              threadIdentifier: "aviadox-slot",
              extra: { tab: "sm", type: "slot" },
            },
          ],
        });
        return true;
      } catch (_) {
        return false;
      }
    }

    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg && typeof reg.showNotification === "function") {
            await reg.showNotification(ttl, { body: msg, tag: "aviadox-slot", icon: "icons/icon-192.png", data: { tab: "sm" } });
            return true;
          }
        }
        new Notification(ttl, { body: msg, tag: "aviadox-slot" });
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  /* ---------- 3. Evrak & Bakım Hatırlatmaları (ID: 9100–9199, diğer bildirimlerden izole) ---------- */
  async function syncExpiryReminders(S) {
    const ln = LN();
    if (!ln || !S || !S.user) return;
    const ok = await ensureLocalPermission(false);
    if (!ok) return;

    // Önce yalnızca 9100..9199 aralığındaki eski hatırlatmaları temizle (9001 GPX ve Push'a dokunma!)
    try {
      const pend = await ln.getPending();
      const old = (pend && pend.notifications ? pend.notifications : []).filter(
        (n) => n.id >= IDS.REMINDER_MIN && n.id <= IDS.REMINDER_MAX
      );
      if (old.length) {
        await ln.cancel({ notifications: old.map((n) => ({ id: n.id })) });
      }
    } catch (_) {}

    const items = [];
    const pushItem = (label, ymd, tab) => {
      if (!ymd) return;
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd));
      if (!m) return;
      const exp = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0);
      const now = Date.now();
      // 7 gün kala ve 1 gün kala sabah 09:00 hatırlatması
      for (const daysBefore of [7, 1]) {
        const at = new Date(exp.getTime() - daysBefore * 864e5);
        if (at.getTime() > now + 60000) {
          items.push({
            title: "AviaDoX · Süre Hatırlatması",
            body:
              daysBefore === 1
                ? `${label} yarın sona eriyor (${ymd}).`
                : `${label} için ${daysBefore} gün kaldı (${ymd}).`,
            at,
            tab,
          });
        }
      }
    };

    (S.balloons || []).forEach((b) => {
      const annual = b.a || b.yearly;
      const reg = b.r || b.reg || "Balon";
      if (annual) pushItem(`${reg} yıllık bakımı`, annual, "bk");
    });
    (S.bdocs || []).forEach((d) => {
      const b = (S.balloons || []).find((x) => x.id === d.b);
      const reg = (b && (b.r || b.reg)) || "Balon";
      pushItem(`${reg} · ${d.t}`, d.d, "bk");
    });
    (S.docs || []).forEach((d) => {
      if (d.k === "co") {
        pushItem(`İşletme evrakı · ${d.t}`, d.d, "co");
      } else {
        const p = (S.people || []).find((x) => x.id === d.sid);
        pushItem(`${(p && p.n) || "Personel"} · ${d.t}`, d.d, "pe");
      }
    });

    items.sort((a, b) => a.at.getTime() - b.at.getTime());
    const capped = items.slice(0, IDS.REMINDER_MAX - IDS.REMINDER_MIN + 1);
    if (!capped.length) return;

    try {
      await ln.schedule({
        notifications: capped.map((it, idx) => ({
          id: IDS.REMINDER_MIN + idx,
          title: it.title,
          body: it.body,
          schedule: { at: it.at },
          channelId: "aviadox_reminders",
          threadIdentifier: "aviadox-reminders",
          extra: { tab: it.tab, type: "reminder" },
        })),
      });
    } catch (_) {}
  }

  async function clearReminders() {
    const ln = LN();
    if (!ln) return;
    try {
      const pend = await ln.getPending();
      const old = (pend && pend.notifications ? pend.notifications : []).filter(
        (n) => n.id >= IDS.REMINDER_MIN && n.id <= IDS.REMINDER_MAX
      );
      if (old.length) {
        await ln.cancel({ notifications: old.map((n) => ({ id: n.id })) });
      }
    } catch (_) {}
  }

  return {
    IDS,
    init,
    ensureLocalPermission,
    enablePushNotifications,
    showGpxStatus,
    clearGpxStatus,
    showNotamAlert,
    showSlotAlert,
    syncExpiryReminders,
    clearReminders,
    getPushToken: () => state.pushToken,
    onPush: (fn) => {
      if (typeof fn === "function") state.pushListeners.push(fn);
    },
    onToken: (fn) => {
      if (typeof fn === "function") {
        state.tokenListeners.push(fn);
        if (state.pushToken) fn(state.pushToken);
      }
    },
  };
})();
window.AVNOTIF = AVNOTIF;
