# AviaDoX iOS (.ipa) Derleme, Arka Plan GPX ve Kilit Ekranı Bildirim Rehberi

## 1. Klasör Yapısını Hazırlayın
```
aviadox-ios/
├── package.json
├── capacitor.config.json
├── .github/workflows/build-ipa.yml
├── ios-config/
│   ├── Info.plist.additions.xml
│   ├── AppDelegate.swift
│   └── FlightLiveActivity.swift   (opsiyonel: iOS 16.2+ Live Activity)
└── www/
    ├── index.html          (mevcut projenizden — <script src="notifications.js"></script> ekleyin)
    ├── style.css           (mevcut projenizden)
    ├── config.js           (mevcut projenizden — Supabase URL/Key)
    ├── slot.js             (mevcut projenizden)
    ├── icons/              (mevcut projenizden)
    ├── notifications.js    (bu paketten — Kilit ekranı GPX + çoklu bildirim yöneticisi)
    ├── app.js              (bu paketten — düzeltilmiş + AVNOTIF entegreli)
    ├── flightlog.js        (bu paketten — arka plan GPX + kilit ekranı bildirimi)
    ├── weather.js          (bu paketten — düzeltilmiş)
    ├── i18n.js             (bu paketten — iOS 13+ uyumlu)
    ├── privacy.js          (bu paketten — iOS arka plan bildirimi ekli)
    └── gizlilik.html       (bu paketten — düzeltilmiş)
```

> **Önemli:** `www/index.html` içinde `app.js` ve `flightlog.js` satırlarının **üstüne** şu satırı ekleyin:
> ```html
> <script src="notifications.js"></script>
> ```
> (Eklemeyi unutsanız bile `flightlog.js` dahili yedek kodla kilit ekranı GPX bildirimini yine gösterir.)

---

## 2. Kilit Ekranı GPX Bildirimi ve Diğer Bildirimlerin Birlikte Çalışması

Uygulamada birden fazla bildirim türü olduğu için **bildirim ID ve kanal izolasyonu** uygulandı:

| Bildirim Türü | ID / Kanal | Davranış |
|---|---|---|
| **GPX Arka Plan Kaydı** | `ID: 9001` · `aviadox-gpx` | `Start` ile başlar, kilit ekranında sessizce her 30 sn'de bir aynı kartta (süre, irtifa, hız, yön°) güncellenir. `Stop` ile **yalnızca 9001 silinir**. |
| **NOTAM Saha İhlali** | `ID: 9002` · `aviadox-notam` | Ekran kilitliyken NOTAM sahasına girilir/yaklaşılırsa sesli acil kilit ekranı uyarısı verir. |
| **Evrak & Bakım Hatırlatma** | `ID: 9100–9199` · `aviadox-reminders` | Balon yıllık muayene ve evrakların 7 gün ve 1 gün öncesi 09:00 hatırlatması. |
| **Slot Merkezi & Uzak Push** | APNs (`@capacitor/push-notifications`) | `AppDelegate.swift` + `UIBackgroundModes: remote-notification` ile diğer bildirimlerle çakışmadan kilit ekranında ve uygulama açıkken görünür. |

---

## 3. Mac / Xcode ile İmzalı .ipa Üretme
```bash
npm install
npx cap add ios
cp ios-config/AppDelegate.swift ios/App/App/AppDelegate.swift
npx cap sync ios
```
1. `ios-config/Info.plist.additions.xml` içeriğini `ios/App/App/Info.plist` içindeki `<dict>` bloğuna ekleyin.
2. `npx cap open ios` ile Xcode'u açın.
3. **Signing & Capabilities** sekmesinden:
   - Apple Developer Team seçin, Bundle Identifier'ı (`com.aviadox.app`) belirleyin.
   - **+ Capability > Background Modes** → **Location updates** VE **Remote notifications** işaretleyin.
   - **+ Capability > Push Notifications** ekleyin (Slot Merkezi ve diğer uzak bildirimler için).
4. Menüden **Product > Archive > Distribute App** adımlarıyla imzalı `.ipa` dosyasını dışa aktarın.

## 4. Mac Olmadan GitHub Actions ile .ipa Üretme
1. Klasörü özel bir GitHub deposuna yükleyin.
2. **Actions > Build AviaDoX iOS IPA > Run workflow** ile çalıştırın; **Artifacts** bölümünden `AviaDoX-unsigned.ipa` dosyasını indirin.
