# Build the iPhone app on your Mac

You only need the Mac to **sign and install** the app. All the code lives in
git and can be edited on any OS. GitHub Actions already checks that everything
compiles, so if a step here fails it is almost always a signing/Apple-account
thing, not a code thing.

Two kinds of steps:

- **ONE-TIME**: do once, never again.
- **EVERY WEEK**: a free Apple ID signs the app for 7 days. After that the app
  refuses to open until you re-install it from Xcode (about 2 minutes once set
  up). A paid Apple Developer membership removes the limit.

## Bundle ids: pick yours first

The repo ships placeholder ids. Apple ties an explicit App ID to one team, so
before you sign for the first time replace them with ids of your own, and
then keep them: Apple remembers them for a year, and a Personal Team gets only
a handful of App IDs per week.

| What | Placeholder in the repo | Yours, for example |
|---|---|---|
| App bundle ID | `app.airflash.ios` | `com.yourname.airflash` |
| Share extension bundle ID | `app.airflash.ios.share` | `com.yourname.airflash.share` |
| App Group | `group.app.airflash.ios` | `group.com.yourname.airflash` |
| Project to open | `ios/App/App.xcodeproj` (there is **no** `.xcworkspace`) | |

Search-and-replace the three strings in `capacitor.config.json`,
`ios/App/App/Info.plist`, `ios/App/App/App.entitlements`,
`ios/App/ShareExtension/ShareExtension.entitlements`,
`ios/App/ShareExtension/ShareViewController.swift`,
`scripts/ios-add-share-extension.js` and
`ios/App/App.xcodeproj/project.pbxproj`. Keep that change local (do not
include it in pull requests). The rest of this page uses the placeholders.

---

## ONE-TIME: set up the Mac

1. **Install Xcode 26** from the App Store (it is big; start it early). Open it
   once and let it install the extra components. Then in Terminal:
   ```bash
   xcode-select --install
   ```
   The Xcode point release must be at least as new as your iPhone's iOS 26.x,
   otherwise Xcode cannot talk to the phone. Xcode 26.0–26.3 needs macOS 15.6
   or newer; Xcode 26.4–26.6 needs macOS 26.2 or newer. If the App Store
   refuses to install the Xcode you need, update macOS first (Apple's table:
   https://developer.apple.com/support/xcode/).
2. **Install Node 22**: `brew install node@22` (install Homebrew from brew.sh
   first if `brew` is missing). You do not need CocoaPods, and you do not need
   to log in to GitHub to clone: the repo is public.
3. **Sign in to Xcode with your Apple ID**: Xcode > Settings > Accounts > `+` >
   Apple Account. It shows up as "Your Name (Personal Team)". That is the free
   tier and it is enough.

## EVERY WEEK (and the first time): get the code and open it

```bash
git clone https://github.com/michaelmandich/airflash && cd airflash   # first time
git pull                                                             # every time after that
npm ci
npm run build:mobile
npx cap sync ios
open ios/App/App.xcodeproj
```

Xcode now downloads the Swift packages (Capacitor and the plugins). Wait for
the spinner at the top to stop. If it complains about packages: File >
Packages > Reset Package Caches, then wait again.

## ONE-TIME: signing (two targets)

In the left sidebar click the blue **App** project at the very top. In the
middle you see a list of **Targets**: `App` and `ShareExtension`.

4. **Target App** > tab **Signing & Capabilities**:
   - tick **Automatically manage signing**
   - Team: **Your Name (Personal Team)**
   - Bundle Identifier should say your app id (the placeholder is
     `app.airflash.ios`)
   - Under the signing box you should see **App Groups** with your group
     (placeholder `group.app.airflash.ios`) ticked, and **Background Modes**
     with "Background fetch" ticked. Both come from files in git. If App
     Groups is missing, click `+ Capability` > App Groups > `+` > type the
     group name exactly > tick it.
5. **Target ShareExtension** > tab **Signing & Capabilities**: same thing.
   - tick **Automatically manage signing**, Team = Personal Team
   - Bundle Identifier = your app id + `.share` (placeholder
     `app.airflash.ios.share`)
   - **App Groups** with the same group ticked (add it the same way if it is
     missing).
6. **Check the extension is wired up** (it was added by a script, not by
   Xcode, so look once):
   - Target App > tab **Build Phases** > open **Embed App Extensions** (Xcode
     may call it "Embed Foundation Extensions"). It must list
     `ShareExtension.appex`.
   - Target App > tab **Build Phases** > **Dependencies** (or "Target
     Dependencies") must list `ShareExtension`.
   - If either is missing, or Xcode shows the ShareExtension files in red,
     use the appendix at the bottom and rebuild the target by hand.

If Xcode shows a red error saying **"Personal development teams ... do not
support the App Groups capability"**, stop here: the fallback without App
Groups is described in [ios-build-plan.md](ios-build-plan.md), section 6.
Please open an issue with the exact message so the docs can be updated; do
not try to work around it in the project files.

## ONE-TIME: prepare the iPhone

7. Plug the iPhone into the Mac with a **cable** (the first pairing cannot be
   wireless). On the phone tap **Trust This Computer** and enter the passcode.
8. On the phone: Settings > Privacy & Security > scroll down to **Developer
   Mode** (it only appears once the phone has been plugged into a Mac with
   Xcode) > turn it on > the phone restarts > confirm again after restart.

## EVERY WEEK: install the app

9. In Xcode's toolbar, make sure the scheme says **App** and the device next
   to it is **your iPhone** (not a simulator). Press **Cmd+R**.
   - The first time, Xcode registers your phone and the two app IDs with
     Apple. This can take a minute.
   - If the phone says **"Untrusted Developer"** when you open the app:
     Settings > General > VPN & Device Management > tap your Apple ID under
     "Developer App" > **Trust**. The phone needs internet for this.
10. First launch only: say **Allow** to "AirFlash would like to find and
    connect to devices on your local network". Later it will also ask to add
    photos to your library and to send notifications; allow both.

After the first week the app stops opening (that is the 7-day limit). Just do
the **EVERY WEEK** steps again: `git pull`, `npm ci`, `npm run build:mobile`,
`npx cap sync ios`, open the project, Cmd+R. Do not rename anything.

## ONE-TIME, optional: unplug the cable

11. Xcode > Window > Devices and Simulators > select the iPhone > tick
    **Connect via network**. From then on Cmd+R works over Wi-Fi as long as
    Mac and phone are on the same network.

## Limits of a free Apple ID (good to know)

- 7-day signing, so weekly re-install.
- At most 3 apps installed this way per phone, and only a handful of app IDs
  per week. AirFlash uses 2 app IDs (app + share extension). Never change
  your bundle IDs once registered.
- No push notifications. Notifications only arrive while AirFlash is open or
  was just backgrounded.

---

## Appendix: build the ShareExtension target by hand

Only if step 6 showed that the target is broken or missing. This replaces the
script-made target with one Xcode makes itself.

a. In Terminal, inside the repo: `mv ios/App/ShareExtension /tmp/ShareExtension-src`
   (keeps the committed files aside).
b. If a broken `ShareExtension` target exists: click the blue App project >
   select the `ShareExtension` target in the Targets list > press Delete
   (Backspace) > confirm.
c. Xcode: File > New > Target... > iOS > **Share Extension** > Next. Product
   Name `ShareExtension`, Team = Personal Team, Language Swift, Embed in
   Application = App > Finish. When asked "Activate ShareExtension scheme?"
   click **Cancel**.
d. Terminal: `rm -f ios/App/ShareExtension/*; cp /tmp/ShareExtension-src/* ios/App/ShareExtension/`
   (replaces Xcode's `ShareViewController.swift` and `Info.plist`, drops
   `MainInterface.storyboard`).
e. Back in Xcode. If the ShareExtension folder in the sidebar has a blue
   folder icon, the files are picked up automatically. If it is a yellow
   folder: delete the red `MainInterface.storyboard` entry, then drag
   `ShareViewController.swift`, `Info.plist` and `ShareExtension.entitlements`
   from Finder into that folder with target **ShareExtension** ticked (only
   the Swift file needs "Add to target"; untick it for the plist and
   entitlements if asked).
f. Target ShareExtension > Signing & Capabilities: Automatically manage
   signing, Team = Personal Team, change the Bundle Identifier to your app id
   + `.share`, `+ Capability` > App Groups > tick your group.
g. Target ShareExtension > Build Settings (search box at the top right):
   **iOS Deployment Target** = 16.0, **Info.plist File** =
   `ShareExtension/Info.plist`, **Code Signing Entitlements** =
   `ShareExtension/ShareExtension.entitlements`, **Generate Info.plist File**
   = No.
h. Target App > Build Phases > "Embed Foundation Extensions" must list
   `ShareExtension.appex` (Xcode did this in step c).
i. If the new target definition works where the scripted one did not, open a
   pull request with the `ios/App/App.xcodeproj/project.pbxproj` change (with
   the placeholder bundle ids restored) so everyone gets it.
