# AirFlash iOS (Capacitor) — Build Plan

Toolchain target: Capacitor 8.5.x, Xcode 26.x, iOS 26, free Apple ID (Personal Team). Development happens on any OS with Node 22; a Mac is used only to sign and run; GitHub Actions (macos-26) compile-checks every push. The Mac steps are also written out as a checklist in [ios-mac-setup.md](ios-mac-setup.md).

Legend: **[verified]** = checked against primary sources in the research pass; **[uncertain]** = plausible but not confirmed; **[test-first]** = must be validated on the phone before building more on it.

---

## 1. Decisions (exact packages)

Pin exact versions (no `^`). All plugins below require `@capacitor/core >=8.0.0` and iOS 15+.

| Role | Package | Why | Verification outcome |
|---|---|---|---|
| Core | `@capacitor/core@8.5.3`, `@capacitor/ios@8.5.3`, `@capacitor/cli@8.5.3` (dev) | Latest stable (2026-10-07). 8.5.x adopts the UIScene lifecycle (needed for Xcode 27 later) and 8.5.1+ fixes the Windows backslash bug in `CapApp-SPM/Package.swift` (PR [#8549](https://github.com/ionic-team/capacitor/pull/8549)). Requires Node 22+, Xcode 26.0+, iOS deployment target 15.0, SPM default ([docs](https://capacitorjs.com/docs/updating/8-0)). Do not use 9.0.0-alpha. | **[verified]** `cap add ios` / `cap sync ios` have no host-OS gate in the 8.5.3 CLI source; SPM path never invokes pod/xcodebuild/swift. Earlier 7.x/8.0–8.5.0 CLIs write backslash paths on Windows (refuted part of the original claim) — 8.5.3 is safe. |
| Share sheet (receive) | `@capgo/capacitor-share-target@8.0.60` + **your own** Share Extension target | Only free, maintained Capacitor-8 plugin on public npm (MPL-2.0, 0 open bugs, 2026-10-12). Mechanism: extension writes `{title, texts, files:[{uri,name,mimeType}]}` to `UserDefaults(suiteName: appGroupId)` key `share-target-data`, opens `airflash://share`; plugin emits `shareReceived` (retained until a JS listener consumes it; also re-checked on `didBecomeActive`). Uses `.capacitorOpenURL`, so no AppDelegate/SceneDelegate code is needed ([README](https://github.com/Cap-go/capacitor-share-target), [plugin source](https://raw.githubusercontent.com/Cap-go/capacitor-share-target/main/ios/Sources/CapacitorShareTargetPlugin/CapacitorShareTargetPlugin.swift)). Rejected: `@mindlib-capacitor/send-intent@8.0.6` (AppDelegate `open:options:` handler breaks under UIScene, 21 open issues), `@capawesome-team/capacitor-share-target` (paid, private registry). | **[verified]** App Groups are ticked in the free "Apple Developer" column of Apple's capability table ([supported-capabilities-ios](https://developer.apple.com/help/account/reference/supported-capabilities-ios)); DTS maps that column to Personal Teams ([thread 836943](https://developer.apple.com/forums/thread/836943)); app+extension App Group builds on a Personal Team reported in Jun–Oct 2026 ([834802](https://developer.apple.com/forums/thread/834802), [NextBeat](https://github.com/Blue4u0610/NextBeat)). Constraint: exactly ONE App Group ([xtool #284](https://github.com/xtool-org/xtool/pull/284)). The README's ShareViewController is a stub — the extension code is ours (section 5 has the files). **[test-first]** on the Mac: if Xcode prints "Personal development teams … do not support the App Groups capability", go to fallback (section 6). |
| Background upload | `@capgo/capacitor-uploader@8.3.24` | iOS uses `URLSessionConfiguration.background(withIdentifier: "CapacitorUploaderBackgroundSession")`; `method:'PUT'` (or `uploadType:'binary'`) calls `uploadTask(with:fromFile:)` with the raw file as body, custom headers, `uploading/completed/failed` events with `percent`. URLSession sets `Content-Length` from the file size, which is exactly what `PUT /api/drops/:id/files/:fid?token=T` expects — **no server-side multipart endpoint needed** ([Uploader.swift](https://unpkg.com/@capgo/capacitor-uploader@8.3.24/ios/Sources/UploaderPlugin/Uploader.swift)). Background URLSession needs no entitlement; `Background modes` (fetch) is free-tier ([Apple](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background)). | **[verified]** by two independent source reads. Gaps: no `handleEventsForBackgroundURLSession` hook and no on-disk event persistence on iOS (README claims otherwise) — add the AppDelegate hook (section 5) and poll `GET /api/drops` on resume. The plugin overwrites `Content-Type` with `mimeType`, so pass `mimeType`. |
| Upload fallback (foreground only) | `@capacitor/file-transfer@2.0.6` | Official; raw PUT when a `Content-Type` header is set explicitly; also used for **downloads** (`downloadFile` with progress). Uses `URLSession(.default)` — dies when the phone locks, so it is NOT the primary uploader ([IONFLTRManager.swift](https://github.com/ionic-team/ion-ios-filetransfer/blob/main/IONFileTransferLib/IONFLTRManager.swift)). | **[verified]** not background. No Range resume. |
| Media picker (originals) | `@capawesome/capacitor-file-picker@8.1.0` | `FilePicker.pickMedia({limit:0, skipTranscoding:true, readData:false})` → PHPicker (no photo permission), `preferredAssetRepresentationMode = .current`, `loadFileRepresentation` + `FileManager.copyItem` into Caches; returns `{path, name, size, mimeType, width, height, duration}` without loading bytes into JS ([FilePicker.swift](https://unpkg.com/@capawesome/capacitor-file-picker@8.1.0/ios/Plugin/FilePicker.swift)). Rejected: `@capacitor/camera` `chooseFromGallery` (since 8.2.x a custom picker needing full library permission; quality options ignored, [issue #74](https://github.com/ionic-team/capacitor-camera/issues/74)). | **[verified with correction]** "original/untouched" is overstated: `.current` returns the *current (edited)* rendition and Apple only promises "avoids transcoding, if possible" — HEIC stays HEIC in practice; HEVC passthrough is likely but one unanswered report shows MPEG-4 ([thread 736545](https://developer.apple.com/forums/thread/736545)); Live Photos arrive as the still only; Slo-Mo effects baked in. **[test-first]** compare `size`/codec of a 4K HEVC clip on the PC. |
| Save to Photos | `@capacitor-community/media@9.1.0` | Plugin v9 = Capacitor 8, SPM. `savePhoto({path:'file://…'})` uses `PHAssetCreationRequest.addResource(.photo, data:)` (HEIC kept); `saveVideo({path:'file://…'})` uses `creationRequestForAssetFromVideo(atFileURL:)` (HEVC kept); add-only permission via `NSPhotoLibraryAddUsageDescription` ([MediaPlugin.swift](https://unpkg.com/@capacitor-community/media@9.1.0/ios/Sources/MediaPlugin/MediaPlugin.swift)). | **[verified]** from source. Pulls SDWebImage (longer CI builds). No Live Photo support. |
| Bonjour discovery | **In-repo Swift plugin** `airflash-bonjour` (local npm package, ~150 lines on `NWBrowser(for: .bonjour(type:"_airflash._tcp", domain:nil))`) | `capacitor-zeroconf@4.0.0` (2025-05-09) is CocoaPods-only (no `Package.swift`), so the SPM CLI drops it with a warning; it uses deprecated `NetServiceBrowser` and is untested on Capacitor 8 ([npm](https://registry.npmjs.org/capacitor-zeroconf)). Capawesome's zeroconf is paid. Browsing a declared type needs only `NSBonjourServices` + `NSLocalNetworkUsageDescription`, no entitlement ([TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)). | **[verified]** requirements. The plugin itself is unwritten; CI compiles it, the phone tests it. Discovery is a convenience; the typed base URL is the primary path. |
| Local notifications | `@capacitor/local-notifications@8.3.1` | Free-tier; `schedule()` auto-requests permission since 8.3.0; use `foreground:true`. Do NOT use `interruptionLevel: 'timeSensitive'`/`critical` (paid capabilities) ([docs](https://capacitorjs.com/docs/apis/local-notifications)). | **[verified]** APNs push is impossible on a Personal Team ([DTS 811929](https://developer.apple.com/forums/thread/811929)); background "something arrived" notifications are therefore best-effort only (section 6). |
| Filesystem / app / prefs | `@capacitor/filesystem@8.1.4`, `@capacitor/app@8.1.2`, `@capacitor/preferences@8.x` (take latest 8.x at install) | `Filesystem.stat/deleteFile/getUri`; `App` for `appStateChange`/`resume`/`getLaunchUrl`; `Preferences` for the server base URL and device secret. | **[verified]** versions for filesystem/app; preferences version **[uncertain]** (not checked). |
| Bundler for the native glue | `esbuild` (dev, latest 0.25.x at install) | The web UI has no bundler, but Capacitor plugin JS uses bare `import '@capacitor/core'` specifiers that WKWebView cannot resolve. Bundle only `src/mobile/native.js` into one IIFE; the rest of `src/web` stays unbundled. | **[uncertain]** exact esbuild version; any 0.2x works. |

---

## 2. Project layout — reuse of `src/web`

Two options:

**A. Bundled copy (recommended).** Capacitor `webDir` = a generated `www/` that contains `src/web` + `native.js`. Origin inside the app is `capacitor://localhost`; the node at `http://<ip>:4747` (later `https://relay…`) is a cross-origin API.
- Consequences: the node must answer CORS (preflights for `PUT`, JSON `POST`, and the custom `X-AirFlash-Device` header); ATS does not apply to IP literals, `.local`/unqualified names need `NSAllowsLocalNetworking` ([Apple ATS reference](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CocoaKeys.html)). The UI works offline (launches without a node), the base URL is a setting, plugins are available on `window`, and the Share Extension handoff lands in our own page.

**B. Load the node's page remotely** (`server.url`/`allowNavigation`). No CORS needed, but: the page must be reachable at launch, the relay URL is baked into config, `server.url` is documented as "not intended for production" ([config docs](https://capacitorjs.com/docs/config)), and the node's CSP (`connect-src 'self'` in `src/core/static.js`) would have to be relaxed. Rejected.

### Required changes in the repo (Windows)

1. `src/web/lib/client.js` and `src/web/app.js` currently use root-relative URLs (`/api/events?…`, `/api/drops/...`, `location.origin`, `/api/qr.svg`). Introduce `apiBase()`:
   - Browser/Electron (served by the node): returns `''` (unchanged behaviour).
   - Native (`window.Capacitor?.isNativePlatform()`): returns the configured base, e.g. `http://192.0.2.15:4747` or `https://relay.example.com` (stored via Preferences, prefilled by Bonjour).
   - `new EventSource(apiBase() + '/api/events?' + q)` — EventSource cannot set headers, which is why the secret is already in the query. Cross-origin EventSource from `capacitor://` to `http://` needs only `Access-Control-Allow-Origin` **[test-first]**.
   - `shareOrigin()` / QR: use `apiBase()` instead of `location.origin` on native.
2. Asset paths in `index.html` (`/app.js`, `/styles.css`, `/icons/…`) are fine: Capacitor serves `webDir` at the origin root. Remove/skip the "Add to Home Screen" tip and the `/d/CODE` route on native.
3. Node CORS (`src/core/index.js`, before `handleApi`): for `url.pathname.startsWith('/api/')`:
   ```
   Origin allow-list: capacitor://localhost, ionic://localhost (+ configurable extra origins for the relay; NOT http(s)://localhost, which any other local web server would share)
   OPTIONS → 204 with: Access-Control-Allow-Origin: <echoed origin>, Vary: Origin,
     Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS,
     Access-Control-Allow-Headers: Content-Type, X-AirFlash-Device, Range,
     Access-Control-Max-Age: 86400
   All /api responses: Access-Control-Allow-Origin + Vary: Origin,
     Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Disposition
   ```
   The peer-forwarding proxy (`forwardToPeer`) must copy these too (or add them after the proxied response). Native uploads/downloads (URLSession) are not subject to CORS; only WebView `fetch`/`EventSource` are. Reference: [Ionic CORS doc](https://ionicframework.com/docs/troubleshooting/cors) (origin is `capacitor://localhost` on iOS).
4. New files:
   ```
   capacitor.config.ts                 # root (section 5)
   src/mobile/native.js                # imports plugins, exposes window.AirFlashNative = { pickMedia, upload, saveToPhotos, discover, notify, onShare, ... }
   scripts/build-mobile.js             # copies src/web -> www/, injects <script src="/native.js"></script> into www/index.html, runs esbuild on src/mobile/native.js -> www/native.js (format iife, target safari16)
   native/airflash-bonjour/            # local Capacitor plugin: package.json (name "airflash-bonjour", "capacitor": {"ios": {"src": "ios"}}), Package.swift, ios/Sources/AirflashBonjourPlugin/*.swift, src/index.ts or plain dist/esm/index.js
   ios/                                # generated by cap add ios (section 3), committed
   ios/App/ShareExtension/             # ShareViewController.swift, Info.plist, ShareExtension.entitlements (section 5), committed
   ```
   `package.json`: add `"build:mobile": "node scripts/build-mobile.js"`, dependency `"airflash-bonjour": "file:native/airflash-bonjour"`; `.gitignore`: `www/`. Keep `electron-builder` `files` as is (it does not include `www`/`ios`).
5. Native flows (in `src/mobile/native.js`):
   - **Send**: `FilePicker.pickMedia({limit:0, skipTranscoding:true})` → `POST /api/drops` with declared `size` taken from the picker result (or `Filesystem.stat({path})` right before declaring) → for each file `Uploader.startUpload({filePath: path, serverUrl: `${base}/api/drops/${id}/files/${fid}?token=${T}`, method:'PUT', uploadType:'binary', mimeType, headers:{'X-AirFlash-Device': secret}, maxRetries:3})` → on `completed`, `Filesystem.deleteFile` the Caches copy.
   - **Share sheet**: `CapacitorShareTarget.addListener('shareReceived', …)` at startup; `files[].uri` are `file://` paths in the App Group container — pass them straight to the uploader (no JS read); `texts[]` → text drop. Accept only files inside the App Group `Inbox/`. Do NOT read a payload from the `airflash://share` URL itself (any app can open it); the plugin already re-reads the App Group on open-URL and `didBecomeActive`, which covers cold start.
   - **Receive**: on SSE drop event, `FileTransfer.downloadFile({url: `${base}/api/drops/${id}/files/${fid}`, path: <Filesystem.getUri(Directory.Cache, name)>, headers:{'X-AirFlash-Device': secret}, progress:true})` → `Media.savePhoto`/`saveVideo` by MIME → delete cache copy; non-media → `Share` sheet or keep in Documents.
   - **Lifecycle**: `App.addListener('appStateChange')`: close EventSource when inactive, reopen + `GET /api/drops` diff on active; show `LocalNotifications.schedule({notifications:[{id, title, body, foreground:true, schedule:{at:new Date(Date.now()+1000)}}]})` for new drops.

---

## 3. iOS project: Windows vs Mac

### 3a. On Windows (repeatable)

```powershell
npm i -E @capacitor/core@8.5.3 @capacitor/ios@8.5.3 @capgo/capacitor-share-target@8.0.60 @capgo/capacitor-uploader@8.3.24 @capawesome/capacitor-file-picker@8.1.0 @capacitor-community/media@9.1.0 @capacitor/local-notifications@8.3.1 @capacitor/filesystem@8.1.4 @capacitor/app@8.1.2 @capacitor/file-transfer@2.0.6 @capacitor/preferences
npm i -D -E @capacitor/cli@8.5.3 esbuild
npx cap init AirFlash app.airflash.ios --web-dir www
npm run build:mobile
npx cap add ios            # SPM template; prints "Adding native Xcode project in ios" and runs sync
npx cap sync ios           # rewrites ios/App/CapApp-SPM/Package.swift; no pod/xcodebuild needed
```
Expected: no CocoaPods/xcodebuild warnings in SPM mode. Check `ios/App/CapApp-SPM/Package.swift` has `.iOS(.v15)` (or your target) and Unix-style `../../node_modules/...` paths and one `.product` per plugin (a plugin without `Package.swift` is dropped with a warning). There is **no** `App.xcworkspace`; the project is `ios/App/App.xcodeproj` ([SPM docs](https://capacitorjs.com/docs/ios/spm)).

Commit everything under `ios/` except what the template `.gitignore` already excludes (`App/App/public`, `App/App/capacitor.config.json`, `DerivedData`, `xcuserdata`). Edit as text from Windows at any time: `ios/App/App/Info.plist`, `ios/App/App/AppDelegate.swift`, `ios/App/App/App.entitlements`, `ios/App/ShareExtension/*`, `native/airflash-bonjour/**`.

Set the iOS deployment target to 16.0 in `project.pbxproj` (`IPHONEOS_DEPLOYMENT_TARGET = 16.0;` for all configurations) — editable as text.

**Share Extension target**: cannot be created by the Capacitor CLI. Two options:
- **Primary (one-time, on the Mac, ~5 clicks)** — see 3b step 6.
- **Alternative (Windows script, [uncertain])**: Node package `xcode@3.0.1` has `addTarget('ShareExtension','app_extension','ShareExtension','app.airflash.ios.share')` that adds the PlugIns embed phase and target dependency ([pbxProject.js](https://raw.githubusercontent.com/apache/cordova-node-xcode/master/lib/pbxProject.js)), then `addSourceFile`/`addResourceFile` for the Swift/plist and build settings (`CODE_SIGN_ENTITLEMENTS`, `PRODUCT_BUNDLE_IDENTIFIER`, `INFOPLIST_FILE`, `IPHONEOS_DEPLOYMENT_TARGET`, `SWIFT_VERSION`, `TARGETED_DEVICE_FAMILY`). Not validated against Capacitor's current pbxproj object version; only use if CI proves it compiles.

### 3b. Mac checklist (minimal)

Prereqs: Mac on macOS 15.6+ for Xcode 26.0–26.3, or macOS 26.2+ for Xcode 26.4–26.6 ([Xcode support table](https://developer.apple.com/support/xcode/)). Keep Xcode's 26.x point release ≥ the iPhone's iOS 26.x (otherwise "Failed to find a DDI" errors, [thread 812754](https://developer.apple.com/forums/thread/812754)).

1. **[one-time]** Install Xcode 26.x from the App Store; open it once; run `xcode-select --install`. Install Node 22: `brew install node@22` (needed for `npx cap sync`). No CocoaPods.
2. **[one-time]** Xcode > Settings > Accounts > "+" > Apple Account > sign in with the free Apple ID. It appears as "<Name> (Personal Team)".
3. **[every pull]** Terminal:
   ```bash
   git clone https://github.com/michaelmandich/airflash && cd airflash   # later: git pull
   npm ci
   npm run build:mobile
   npx cap sync ios
   open ios/App/App.xcodeproj                   # NOT a .xcworkspace
   ```
   Xcode resolves the SPM packages (clones `capacitor-swift-pm` 8.5.3); if it fails: File > Packages > Reset Package Caches.
4. **[one-time]** Project navigator > "App" project > target **App** > Signing & Capabilities: tick "Automatically manage signing", Team = "<Name> (Personal Team)", Bundle Identifier = your own id in place of the placeholder `app.airflash.ios` (explicit App IDs are tied to one team and cannot be released from a Personal Team, [DTS 843925](https://developer.apple.com/forums/thread/843925)).
5. **[one-time]** Same screen > "+ Capability" > **App Groups** > "+" > `group.app.airflash.ios` (tick it). Also "+ Capability" > **Background Modes** > tick "Background fetch". Xcode writes `App/App.entitlements`; commit it. If Xcode errors "Personal development teams … do not support the App Groups capability" → stop and use the fallback in section 6 (and open an issue with the exact text).
6. **[one-time] Share Extension target**:
   a. Terminal: `mv ios/App/ShareExtension /tmp/ShareExtension-src` (our committed files aside).
   b. Xcode: File > New > Target… > iOS > **Share Extension** > Next. Product Name `ShareExtension`, Team = Personal Team, Language Swift, Bundle Identifier auto = `app.airflash.ios.ShareExtension` → change later to `app.airflash.ios.share` (must be prefixed by the app id), Embed in Application = App > Finish. When asked "Activate ShareExtension scheme?" click **Cancel**.
   c. Terminal: `rm -f ios/App/ShareExtension/*; cp /tmp/ShareExtension-src/* ios/App/ShareExtension/` (replaces Xcode's `ShareViewController.swift`, `Info.plist`, removes `MainInterface.storyboard`). If Xcode 26 created the target as a synchronized folder (blue folder icon), the files are picked up automatically; if it is a classic group (yellow), delete the red missing `MainInterface.storyboard` reference and drag `ShareViewController.swift`, `Info.plist`, `ShareExtension.entitlements` into the group with target "ShareExtension" ticked **[uncertain which Xcode 26 uses by default]**.
   d. Target **ShareExtension** > Signing & Capabilities: Automatically manage signing, Team = Personal Team, Bundle Identifier `app.airflash.ios.share`, "+ Capability" > App Groups > tick the same `group.app.airflash.ios`. Build Settings: iOS Deployment Target = 16.0 (≥ app), Info.plist File = `ShareExtension/Info.plist`, Code Signing Entitlements = `ShareExtension/ShareExtension.entitlements`.
   e. Target App > General > "Frameworks, Libraries, and Embedded Content" / Build Phases > "Embed Foundation Extensions" must list `ShareExtension.appex` (Xcode did this in b).
   f. `git add ios && git commit -m "Add ShareExtension target"` and push — from now on Windows edits the Swift/plist text; the target definition is in git.
7. **[one-time] iPhone**: connect by **USB cable** (iOS 26 cannot pair wirelessly for the first time; that is an Xcode 27 + iOS 27 feature, [Device Hub doc](https://developer.apple.com/documentation/xcode/managing-your-simulated-and-physical-devices-in-device-hub)). Tap "Trust This Computer". Then Settings > Privacy & Security > **Developer Mode** (appears only after pairing starts) > On > Restart > Enable + passcode ([Apple](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)).
8. **[one-time, then weekly]** Xcode toolbar: scheme **App**, destination = your iPhone > **Cmd+R**. First time Xcode registers the device + 2 App IDs (app, extension) on the Personal Team. If iOS shows "Untrusted Developer": Settings > General > VPN & Device Management > Developer App "<Apple ID>" > Trust (needs internet to reach `ppq.apple.com`).
9. **[one-time] Wi-Fi debugging**: Xcode > Window > Devices and Simulators > select the iPhone > tick **Connect via network**; unplug. Same Wi-Fi, IPv6 enabled. (Since Xcode 15 this is always on; the cable is only needed for the first pairing.)
10. **[weekly]** The Personal-Team profile expires after 7 days; the app stops launching until you repeat step 3 + Cmd+R ([Apple memberships](https://developer.apple.com/support/compare-memberships/)). Limits: 10 App IDs and 3 devices per 7 days, 3 apps per device. Do not rename bundle IDs.
11. **[first run only, test-first]** Accept the "AirFlash would like to find and connect to devices on your local network" prompt (triggered by the Bonjour browse); Photos "Add only" prompt on first save; notification prompt.

---

## 4. GitHub Actions (compile check, unsigned)

Public repository: GitHub-hosted runners, macOS included, are free with no minute cap ([billing](https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions)); a private fork on the Free plan gets 2,000 min/month with macOS billed at ~10×. The committed workflow (`.github/workflows/ios.yml`) runs on pushes to `main` that touch the iOS-relevant paths and on manual dispatch, and cancels in-progress runs.

```yaml
name: ios-compile-check
on:
  push: { branches: [main], paths: ['ios/**', 'src/**', 'native/**', 'scripts/**', 'capacitor.config.ts', 'package*.json', '.github/workflows/ios.yml'] }
  workflow_dispatch:
    inputs:
      runner:
        description: macos-26 (default) or macos-15 fallback
        default: macos-26
concurrency: { group: ios-${{ github.ref }}, cancel-in-progress: true }

jobs:
  build:
    runs-on: ${{ github.event.inputs.runner || 'macos-26' }}   # macos-26 image: Xcode 26.6 default; macos-15 image: Xcode 16.4 default (too old) -> select 26.x below
    timeout-minutes: 40
    env:
      SPM_DIR: build/SourcePackages
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }

      - name: Select Xcode 26
        run: |
          if [ -d /Applications/Xcode_26.6.app ]; then sudo xcode-select -s /Applications/Xcode_26.6.app;
          elif [ -d /Applications/Xcode_26.3.app ]; then sudo xcode-select -s /Applications/Xcode_26.3.app;   # macos-15 fallback
          else ls /Applications | grep Xcode; exit 1; fi
          xcodebuild -version

      - run: npm ci
      - run: npm run build:mobile
      - run: npx cap sync ios
      - name: Sanity check generated package
        run: grep -E 'iOS\(\.v1[5-9]\)' ios/App/CapApp-SPM/Package.swift && ! grep -q '\\' ios/App/CapApp-SPM/Package.swift

      # CocoaPods is NOT used (SPM project). If a CocoaPods project is ever added:
      # - run: cd ios/App && pod install   # and switch xcodebuild to -workspace App.xcworkspace

      - name: Cache SwiftPM checkouts and DerivedData
        uses: actions/cache@v4
        with:
          path: |
            build/SourcePackages
            build/DerivedData
          key: spm-${{ runner.os }}-${{ hashFiles('ios/App/CapApp-SPM/Package.swift', 'package-lock.json') }}
          restore-keys: spm-${{ runner.os }}-

      - name: Resolve packages
        run: xcodebuild -resolvePackageDependencies -project ios/App/App.xcodeproj -scheme App -clonedSourcePackagesDirPath "$SPM_DIR"

      - name: Build App (+ ShareExtension via target dependency), unsigned, device SDK
        run: |
          set -o pipefail
          xcodebuild build \
            -project ios/App/App.xcodeproj \
            -scheme App \
            -configuration Debug \
            -destination 'generic/platform=iOS' \
            -derivedDataPath build/DerivedData \
            -clonedSourcePackagesDirPath "$SPM_DIR" \
            -skipMacroValidation -skipPackagePluginValidation \
            CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
            | tee build.log | grep -E 'error:|warning: .*(deprecat|unused)|\*\* BUILD' || true
          grep -q 'BUILD SUCCEEDED' build.log

      - name: Assert the extension was built and embedded
        run: test -d build/DerivedData/Build/Products/Debug-iphoneos/App.app/PlugIns/ShareExtension.appex

      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: xcodebuild-log, path: build.log }
```

Notes: use `-project` (SPM) not `-workspace`; building the `App` scheme compiles the extension because it is a target dependency; with signing disabled, entitlements/App Groups are not validated — only the Mac proves signing. Runner images: macos-26 (20260907) = macOS 26.6.2, Xcode 26.6 default plus 26.0.1–26.5; macos-15 default Xcode 16.4 with 26.0.1–26.3 installed ([runner-images](https://github.com/actions/runner-images)). `macos-latest` currently maps to macos-26 but pin explicitly. Expected duration **[uncertain, unmeasured]**: 8–15 min cold (SPM clone + Swift compile of Capacitor, SDWebImage, plugins), ~4–8 min with warm cache. Unsigned builds are the only option: Apple DTS does not support command-line signing workarounds and Personal-Team signing is not reproducible on a hosted runner ([DTS 766578](https://developer.apple.com/forums/thread/766578)).

---

## 5. Config values

### `capacitor.config.ts`
```ts
import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'app.airflash.ios',
  appName: 'AirFlash',
  webDir: 'www',
  ios: { contentInset: 'automatic', scheme: 'AirFlash' },
  // NO server.url / server.allowNavigation / server.cleartext: the UI is bundled and talks to the node via fetch.
  // NO plugins.CapacitorHttp (it only takes string/JSON bodies natively and breaks streaming/SSE).
  plugins: {
    CapacitorShareTarget: { appGroupId: 'group.app.airflash.ios' },
    LocalNotifications: { presentationOptions: ['banner', 'list', 'sound'] },
  },
};
export default config;
```
`allowNavigation` is only needed if the WebView must *navigate* to an external page; opening `http://<ip>:4747/d/CODE` in Safari via `window.open` / `@capacitor/browser` needs nothing.

### `ios/App/App/Info.plist` (app target) — add
```xml
<key>NSAppTransportSecurity</key>
<dict><key>NSAllowsLocalNetworking</key><true/></dict>   <!-- http://pcname.local:4747; IP literals are exempt from ATS anyway. Do NOT add NSAllowsArbitraryLoads. -->
<key>NSLocalNetworkUsageDescription</key>
<string>AirFlash finds your computers on this Wi-Fi network and sends files to them.</string>
<key>NSBonjourServices</key>
<array><string>_airflash._tcp</string></array>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>AirFlash saves photos and videos you receive to your Photos library.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>AirFlash reads your Photos library only when you choose albums.</string>   <!-- only needed if Media.getAlbums is used; PHPicker needs nothing -->
<key>UIBackgroundModes</key>
<array><string>fetch</string></array>                       <!-- NOT "processing" (needs BGTaskSchedulerPermittedIdentifiers) -->
<key>CFBundleURLTypes</key>
<array><dict>
  <key>CFBundleURLName</key><string>app.airflash.ios</string>
  <key>CFBundleURLSchemes</key><array><string>airflash</string></array>
</dict></array>
```
Bonjour keys go in the **app** Info.plist only; the extension shares the container app's local-network state ([TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)).

### `ios/App/App/App.entitlements` and `ios/App/ShareExtension/ShareExtension.entitlements` (identical content)
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.application-groups</key>
  <array><string>group.app.airflash.ios</string></array>
</dict></plist>
```
Exactly one group; iOS-style `group.` prefix ([Apple](https://developer.apple.com/documentation/xcode/configuring-app-groups)).

### `ios/App/ShareExtension/Info.plist`
```xml
<key>CFBundleDisplayName</key><string>AirFlash</string>
<key>NSExtension</key>
<dict>
  <key>NSExtensionPointIdentifier</key><string>com.apple.share-services</string>
  <key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).ShareViewController</string>  <!-- no storyboard -->
  <key>NSExtensionAttributes</key>
  <dict>
    <key>NSExtensionActivationRule</key>
    <dict>
      <key>NSExtensionActivationSupportsImageWithMaxCount</key><integer>10</integer>
      <key>NSExtensionActivationSupportsMovieWithMaxCount</key><integer>10</integer>
      <key>NSExtensionActivationSupportsFileWithMaxCount</key><integer>10</integer>
      <key>NSExtensionActivationSupportsText</key><true/>
      <key>NSExtensionActivationSupportsWebURLWithMaxCount</key><integer>1</integer>
      <key>NSExtensionActivationSupportsWebPageWithMaxCount</key><integer>1</integer>
      <key>NSExtensionActivationUsesStrictMatching</key><false/>
    </dict>
  </dict>
</dict>
```
(Keys from send-intent and Capawesome docs; keep the Xcode-generated `CFBundle*` keys.)

### `ios/App/ShareExtension/ShareViewController.swift` — behaviour spec
`UIViewController` subclass; in `viewDidLoad` show a small "Sending to AirFlash…" label, then iterate `extensionContext!.inputItems[*].attachments`: for `UTType.movie`, `.image`, `.fileURL` use `loadItem(forTypeIdentifier:)` → file URL → `FileManager.copyItem(at:to: container.appendingPathComponent("Inbox/<uuid>_<name>"))` where `container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.airflash.ios")` (**file-to-file copy, never `Data` in memory** — extension memory is tight); if an image arrives as `UIImage` (screenshots) write it with `pngData()`; `.url` and `.plainText` go to `texts`. Build `files:[["uri": dest.absoluteString, "name": name, "mimeType": mimeByExtension, "size": byteCount]]` (`size` is an extra key — **[uncertain]** whether the plugin passes unknown keys through; fall back to `Filesystem.stat`). Write `["title": ..., "texts": [...], "files": [...]]` to `UserDefaults(suiteName:)` key `share-target-data`, `synchronize()`, open `airflash://share` via the responder-chain `openURL` selector walk, then `extensionContext?.completeRequest(returningItems: nil)`. Models: [Capgo issue #10](https://github.com/Cap-go/capacitor-share-target/issues/10) (images/URL/text, lacks movie), [Capawesome docs](https://capawesome.io/plugins/share-target/) (most complete reference).

### `ios/App/App/AppDelegate.swift` — add (text edit from Windows)
```swift
func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
    // @capgo/capacitor-uploader does not implement this; it recreates the session lazily on plugin load.
    // Pragmatic: let the system finish; JS reconciles state via GET /api/drops on resume.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { completionHandler() }
}
```
**[uncertain]** exact timing; acceptable because uploads complete server-side regardless.

### Node (`src/core/index.js`)
CORS middleware as in section 2 item 3. Optional config `AIRFLASH_CORS_ORIGINS` for the relay.

---

## 6. Known risks and what to test first on the phone

Test in this order on the first Mac session (each takes minutes and gates the next):

1. **Signing with App Groups on the Personal Team** (section 3b steps 4–6, 8). Expected failure modes: "Personal development teams … do not support the App Groups capability" or "Failed Registering Bundle Identifier". Evidence it works is Apple's table + DTS + Oct-2026 field reports, but no reproducible proof. **Fallback**: drop App Groups; the extension copies files into its own `tmp`, then passes paths cannot cross sandboxes — so instead encode small payloads (URLs, text, ≤ ~100 KB base64) in `airflash://share?…` and for photos/videos show "Open AirFlash and pick from Photos" (the picker path still gives originals). Alternatively an App Intent/Shortcuts "Send with AirFlash" action ([yarms PR #5](https://github.com/joshuawyadao/yarms/pull/5) took this route).
2. **CORS + SSE from `capacitor://localhost`** to `http://<ip>:4747`: `/api/node`, `POST /api/drops` (preflight), `EventSource` open and `hello` event. WebView traffic is exempt from the Local Network prompt, so this works even before the prompt ([TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)).
3. **Local Network prompt**: trigger it deliberately in the foreground (Bonjour browse on first launch). A first attempt made in the background is silently denied; there is no API to query state; the simulator does not enforce it; denial shows as `kDNSServiceErr_PolicyDenied (-65570)` in the browser state or `NSURLErrorNotConnectedToInternet` on native requests. Retry once after the prompt.
4. **Background PUT upload**: pick a 500 MB+ video, start upload, lock the phone, confirm on the PC that `Content-Length` matched the declared size and the file completed; then reopen the app and confirm `completed` arrives or the resume poll marks it done. Force-quitting cancels background transfers (Apple); uploads started while already backgrounded are discretionary.
5. **Share sheet**: Photos > select 3 photos + 1 video > Share > AirFlash. Check cold start (app not running) and warm start; one user reported cold-start loss on 8.0.25 ([issue #1](https://github.com/Cap-go/capacitor-share-target/issues/1)) — the plugin's `didBecomeActive` re-read covers it. Large videos: copy time and the extension memory limit (unpublished) — keep copy file-to-file. Delete Inbox files after upload.
6. **Original quality**: compare bytes/codec of an HEIC and an HEVC 4K clip received on the PC vs the phone's Photos info; Live Photos lose the motion part; edited photos arrive edited (PHPicker has no "unadjusted original" mode, [FB9706029 thread](https://developer.apple.com/forums/thread/692407)).
7. **Save to Photos**: receive an HEIC and an HEVC from the PC; check the "Add only" permission prompt and that Photos shows the original format. HEIC cannot be previewed on the Windows receiver — handle preview/conversion desktop-side or offer `convertHeicToJpeg` as an opt-in "compatible" mode.
8. **Notifications**: foreground local notification on SSE drop event; after backgrounding for 10+ minutes, reopen and confirm the resume diff shows new drops. There will be **no** background arrival notifications (APNs needs the paid program); optionally add `@capacitor/background-runner@3.0.0` (Background fetch + processing, free) for best-effort polling at iOS-chosen intervals — not in the first milestone.
9. **Weekly expiry**: after 7 days the app refuses to launch until re-run from Xcode; plan the demo cadence accordingly. Keep bundle IDs stable (2 explicit App IDs are consumed; they cannot be released from the Personal Team).

Other risks:
- Capgo plugins release almost daily (mostly dependency bumps); pin exact versions and read release notes before bumping. 8.0.52 of share-target already mentions Capacitor 9 compatibility.
- `capacitor-zeroconf` would be silently dropped by the SPM CLI (no `Package.swift`); the custom plugin is the only free SPM path. Its Swift code is unproven until CI compiles it and the phone runs it.
- `npx cap migrate` / `spm-migration-assistant` may rewrite `project.pbxproj`; re-check the ShareExtension target after such commands. Xcode 27.2's JSON `project.xcproj` format breaks `cap sync` silently ([issue #8607](https://github.com/ionic-team/capacitor/issues/8607)) — do not convert the project.
- CI only verifies compilation; entitlement/provisioning problems appear only on the Mac.
- `@capacitor/file-transfer` downloads are foreground-only and have no Range resume despite the node supporting Range; large received videos must be downloaded with the app open.
- Capacitor 9 (alpha) will change the SPM layout and tooling requirements; stay on 8.5.x until GA.
