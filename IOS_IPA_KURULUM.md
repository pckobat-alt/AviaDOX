# AviaDoX — Android (.apk) & iOS (.ipa) Kurulum Kılavuzu

Bu paket, AviaDoX web uygulamasının güvenlik denetiminden geçmiş, gereksiz kodları temizlenmiş, **çevrimdışı giriş destekli**, **hareketli GIF açılış logolu** ve **arka planda kesintisiz GPX kaydı + kilit ekranı bildirimli** Android (`.apk`) ve iOS (`.ipa`) Capacitor 6 derleme kitidir.

---

## Paket İçeriği

```text
AviaDoX-Android-iOS-Paketi/
├── package.json                        ← Capacitor 6 (Android + iOS + BackgroundGeolocation + Notifications + Supabase)
├── capacitor.config.json               ← Android/iOS WebView, SplashScreen, Local & Push Notifications ayarları
├── .github/workflows/build-mobile.yml  ← Tek tıkla hem .apk hem .ipa üreten GitHub Actions iş akışı
├── android-config/
│   └── AndroidManifest.additions.xml   ← Android 13/14+ arka plan konum & ön plan servis izinleri
├── ios-config/
│   ├── Info.plist.additions.xml        ← iOS UIBackgroundModes (location + remote-notification) & Live Activities
│   ├── AppDelegate.swift               ← APNs + LocalNotifications köprüsü
│   └── FlightLiveActivity.swift        ← Opsiyonel iOS 16.2+ Dynamic Island / Kilit Ekranı Canlı Etkinlik
└── www/                                ← Tüm temizlenmiş ve çevrimdışı hazır web dosyaları
    ├── index.html                      ← #splash GIF katmanı + yerel Supabase yedeği + notifications.js
    ├── splash.gif                      ← Açılış animasyonlu AviaDoX GIF logosu (kendi GIF'inizle değiştirebilirsiniz)
    ├── styles.css                      ← #splash & çevrimdışı durum çubuğu stilleri
    ├── config.js                       ← Supabase / VAPID / GDPR-KVKK yapılandırması
    ├── notifications.js                ← Kilit ekranı GPX (Süre · İrtifa · Hız · Yön°) + NOTAM + Hatırlatma + Push
    ├── app.js                          ← Güvenlik düzeltmeleri, çevrimdışı mod ve tüm iş akışları
    ├── flightlog.js                    ← Arka plan GPX kaydı, kilit ekranı güncellemesi, çevrimdışı IndexedDB
    ├── slot.js                         ← APK/IPA yerel Push desteği + çevrimdışı önbellek
    ├── weather.js                      ← Null güvenli meteoroloji + çevrimdışı önbellek
    ├── i18n.js                         ← iOS <16.4 uyumlu çeviri motoru + karanlık mod dinleyici
    ├── privacy.js                      ← TR/EN gizlilik politikası (arka plan GPX açıklamalı)
    ├── gizlilik.html                   ← Safe Area uyumlu yasal metin sayfası
    ├── sw.js                           ← Çevrimdışı önbellekli Service Worker (Web/PWA için)
    └── manifest.webmanifest            ← PWA manifest
```

---

## Yöntem 1: GitHub Actions ile Otomatik .apk + .ipa Üretme (Önerilen — Mac Gerekmez)

Eski projenizdeki `ios_build.yml` dosyası **Flutter** içindi ve bu Vanilla JS / Capacitor projesinde çalışmaz. Yerine eklenen `.github/workflows/build-mobile.yml` dosyasını kullanın:

1. ZIP paketini yeni veya mevcut bir GitHub deposunun kök dizinine yükleyin (`.github/workflows/build-mobile.yml` dahil).
2. GitHub'da **Actions** sekmesini açın → **AviaDoX Android (.apk) ve iOS (.ipa) Derleme** iş akışını seçin → **Run workflow** butonuna basın.
3. İşlem tamamlandığında **Artifacts** bölümünden:
   - **`AviaDoX-Android-APK`** (`app-debug.apk` — Android telefona doğrudan kurulabilir)
   - **`AviaDoX-iOS-IPA`** (`AviaDoX-unsigned.ipa` — AltStore / Sideloadly ile imzalanabilir veya Apple Developer hesabınızla App Store/TestFlight'a yüklenebilir)
   dosyalarını indirin.

---

## Yöntem 2: Bilgisayarınızda Android (.apk) Derleme

Gereksinimler: **Node.js 20+**, **Java 17 (JDK)** ve **Android Studio**.

```bash
# 1. Bağımlılıkları kurun ve çevrimdışı Supabase UMD dosyasını www/vendor/ içine kopyalayın
npm install
npm run prepare:web

# 2. Android projesini oluşturun ve senkronize edin
npx cap add android
npx cap sync android

# 3. android-config/AndroidManifest.additions.xml içindeki izinleri ve <service> bloğunu
#    android/app/src/main/AndroidManifest.xml dosyasına ekleyin.

# 4. Doğrudan komut satırından APK üretin (veya Android Studio'da açın)
cd android && ./gradlew assembleDebug
# Çıktı: android/app/build/outputs/apk/debug/app-debug.apk
# İmzalı mağaza APK/AAB için: npx cap open android → Build → Generate Signed Bundle / APK
```

---

## Yöntem 3: macOS + Xcode ile İmzalı iOS (.ipa) Derleme

Gereksinimler: **macOS**, **Xcode 15+**, **CocoaPods** ve **Apple Developer hesabı**.

```bash
# 1. Bağımlılıkları kurun ve çevrimdışı Supabase kütüphanesini paketleyin
npm install
npm run prepare:web

# 2. iOS projesini oluşturun ve AppDelegate.swift dosyasını kopyalayın
npx cap add ios
cp ios-config/AppDelegate.swift ios/App/App/AppDelegate.swift
npx cap sync ios

# 3. ios-config/Info.plist.additions.xml içeriğini ios/App/App/Info.plist <dict> içine ekleyin.

# 4. Xcode'u açın
npx cap open ios
```

Xcode içinde **App → Signing & Capabilities**:
- **Team** olarak Apple Developer hesabınızı seçin.
- **+ Capability → Background Modes** ekleyin ve **Location updates** ile **Remote notifications** seçeneklerini işaretleyin.
- **+ Capability → Push Notifications** ekleyin.
- Üst menüden **Product → Archive → Distribute App** adımlarıyla imzalı `.ipa` (TestFlight / Ad-Hoc / App Store) oluşturun.

---

## Kilit Ekranı GPX Bildirimi ve Bildirim İzolasyonu

Uygulama kilit ekranında kayıt aktifken şu biçimde sessiz bir bildirim gösterir (nokta sayısı yerine yönü derece cinsinden):

> **AviaDoX · GPX Kaydı Aktif**
> `TC-BXX · Süre 00:24:15 · 1420 m · 18 km/sa · Yön 085°`

| Bildirim Türü | Kanal / ID | Davranış |
|---|---|---|
| Arka Plan GPX Kaydı | `ID 9001` (`aviadox_gpx`) | Start ile başlar, 30 sn'de bir sessizce güncellenir; Stop edilince yalnızca 9001 silinir |
| NOTAM Saha Uyarısı | `ID 9002` (`aviadox_notam`) | Ekran kapalıyken kısıtlı sahaya yaklaşma/girişte sesli acil bildirim |
| Evrak / Yıllık Bakım | `ID 9100–9199` (`aviadox_reminders`) | 7 gün ve 1 gün önce saat 09:00 hatırlatması; GPX ve Push'a dokunmaz |
| Slot Merkezi & Diğer Push | `APNs / FCM` (`aviadox_slot`) | Android ve iOS yerel bildirim sistemiyle arka planda çakışmadan iletilir |

---

## Çevrimdışı Giriş ve Hareketli GIF Logosu

- **İnternetsiz Giriş:** `npm run prepare:web` komutu Supabase kütüphanesini `www/vendor/supabase.umd.js` olarak uygulama içine gömer. İnternet yokken:
  1. Daha önce giriş yapmış kullanıcılar önbellekteki çalışma alanı verileriyle otomatik açılır.
  2. İlk kez internet olmadan açan kullanıcılar giriş ekranındaki **"İnternetsiz Devam Et (Çevrimdışı Flight Log)"** butonuyla doğrudan GPX kaydı başlatabilir. Kayıtlar cihazdaki IndexedDB'de saklanır ve internet gelince otomatik senkronize edilir.
- **GIF Açılış Logosu:** `www/splash.gif` dosyası uygulama açılırken animasyonlu tam ekran açılış katmanı olarak gösterilir. Kendi özel logonuzun GIF dosyasını aynı adla (`www/splash.gif`) değiştirmeniz yeterlidir.
