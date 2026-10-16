# Contributing

Thanks for looking. AirFlash is small on purpose: plain Node, a vanilla-JS web
UI with no build step, an Electron shell and a Capacitor iOS app around the
same UI. Keep changes in that spirit.

## Run it

```bash
npm install
npm run desktop   # the desktop app (Electron)
npm start         # or the headless node on http://localhost:4747
npm test          # 49 integration tests that start real nodes
```

`npm start -- --access-key-file ./access.key --allowed-hosts relay.example.com`
starts a node in relay mode locally; see [docs/relay-mode.md](docs/relay-mode.md)
for every flag. The Raspberry Pi installer has its own container tests under
`deploy/pi/test/` (they need Docker).

## Where things live

- `src/core/` is the node, `src/web/` the UI, `src/desktop/` the Electron
  shell, `src/mobile/` and `native/` the iOS glue, `deploy/pi/` the relay
  installer. Tests go in `test/` and use `node --test`.
- Docs are documentation, not a diary: write for a stranger who cloned the
  repo, in the second person, with placeholders (`relay.example.com`,
  `192.0.2.15`) instead of real hosts. Never commit addresses, hostnames,
  keys, SSIDs or anything from your own network; `.gitignore` already
  excludes `.env`, key files and `deploy/pi/local*`.
- The relay docs (`docs/relay-mode.md`) describe the node's behaviour; the
  Pi runbook (`deploy/pi/README.md`) describes one way to run it. Change the
  code and the doc that describes it in the same pull request.

## iOS

The Xcode project under `ios/` is committed, and the GitHub Actions workflow
`.github/workflows/ios.yml` compile-checks the app and the share extension
(unsigned) on a macOS runner. CI is the proof that the project builds; signing
and running on a phone still needs a Mac, see
[docs/ios-mac-setup.md](docs/ios-mac-setup.md).

The bundle ids in the repo (`app.airflash.ios`, `app.airflash.ios.share` and
the App Group `group.app.airflash.ios`) are placeholders. Apple ties an
explicit App ID to one team, so set your own (for example
`com.yourname.airflash`) in `capacitor.config.json`, `ios/App/App/Info.plist`,
the two `.entitlements` files, `ios/App/ShareExtension/ShareViewController.swift`,
`scripts/ios-add-share-extension.js` and `ios/App/App.xcodeproj/project.pbxproj`,
and do not commit that change. Keep the placeholders in pull requests.

## Pull requests

- One topic per pull request, with tests for node behaviour.
- `npm test` must pass and the iOS workflow must stay green.
- Security problems go through the private channel in [SECURITY.md](SECURITY.md),
  not a public issue.
