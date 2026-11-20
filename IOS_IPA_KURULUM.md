# AviaDoX iOS (.ipa) Derleme ve Arka Plan GPX Kurulum Rehberi

## Neden doğrudan burada .ipa üretilemiyor?
Apple `.ipa` paketleri yalnızca **macOS + Xcode + iOS SDK** ile derlenebilir ve iPhone'a yüklemek için bir **Apple Developer İmzalama Sertifikası** (veya AltStore/Sideloadly gibi bir imzalama aracı) gerekir. Ayrıca projenizin eksik kalan web dosyaları (`index.html`, `style.css`, `config.js`, `slot.js`, `icons/`) bu yüklemede yer almamaktadır.

Bu paketteki tüm düzeltilmiş dosyalar ve otomatik macOS `.ipa` derleme iş akışı ile **Mac bilgisayarınız olmasa bile GitHub Actions üzerinden 5 dakikada `.ipa` çıktısı alabilirsiniz.**

---

## 1. Klasör Yapısını Hazırlayın
```
aviadox-ios/
├── package.json
├── capacitor.config.json
├── .github/workflows/build-ipa.yml
└── www/
    ├── index.html          (mevcut projenizden)
    ├── style.css           (mevcut projenizden)
    ├── config.js           (mevcut projenizden — Supabase URL/Key)
    ├── slot.js             (mevcut projenizden)
    ├── icons/              (mevcut projenizden)
    ├── app.js              (bu paketten — düzeltilmiş)
    ├── flightlog.js        (bu paketten — iOS arka plan GPX düzeltilmiş)
    ├── weather.js          (bu paketten — düzeltilmiş)
    ├── i18n.js             (bu paketten — iOS 13+ uyumlu)
    ├── privacy.js          (bu paketten — iOS arka plan bildirimi ekli)
    └── gizlilik.html       (bu paketten — düzeltilmiş)
```

## 2. Seçenek A — Mac / Xcode ile Doğrudan İmzalı .ipa Üretme
```bash
npm install
npx cap add ios
npx cap sync ios
```
1. `Info.plist.additions.xml` içindeki anahtarları `ios/App/App/Info.plist` dosyasının `<dict>` bloğuna ekleyin.
2. `npx cap open ios` ile Xcode'u açın.
3. **Signing & Capabilities** sekmesinden:
   - Apple Developer Team seçin, Bundle Identifier'ı (`com.aviadox.app`) belirleyin.
   - **+ Capability > Background Modes > Location updates** kutucuğunu işaretleyin.
4. Menüden **Product > Archive > Distribute App** adımlarıyla imzalı `.ipa` dosyasını dışa aktarın.

## 3. Seçenek B — Mac Olmadan GitHub Actions ile .ipa Üretme
1. Yukarıdaki klasör yapısını özel (Private) bir GitHub deposuna yükleyin.
2. GitHub'da **Actions > Build AviaDoX iOS IPA > Run workflow** düğmesine basın.
3. İşlem bitince **Artifacts** bölümünden `AviaDoX-unsigned.ipa` dosyasını indirin (Sideloadly / AltStore / Xcode ile imzalayıp iPhone'a kurabilirsiniz).

## 4. iPhone'da Arka Plan GPX Test Kontrol Listesi
- Uygulamayı açıp **Flight Log > Start** dediğinizde iOS konum iznini önce *"Uygulamayı Kullanırken İzin Ver"*, ardından sistem uyarısında **"Her Zaman İzin Ver"** (ve **Tam Konum: Açık**) olarak seçin.
- Ekranı kilitleyin veya başka bir uygulamaya geçin — iPhone sol üst köşede **mavi konum göstergesi** görünmeye devam eder.
- `flightlog.js` içinde arka plan konum callback'i her 15 saniyede bir GPX taslağını IndexedDB'ye yazar, her 5 saniyede bir canlı konum paylaşır ve ekran kapalıyken harita çizimini duraklatarak iOS'un uygulamayı bellekten kapatmasını önler.
