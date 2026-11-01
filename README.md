# MyJDownloader Browser Extension (MV3, unofficial)

Unofficial **Manifest V3** port of the [MyJDownloader browser extension](https://my.jdownloader.org) for Chromium-based browsers. It lets you send links, selections and Click'n'Load packages from your browser to your JDownloader via [my.jdownloader.org](https://my.jdownloader.org) and control it remotely.

> This project is not affiliated with or endorsed by AppWork GmbH. JDownloader and MyJDownloader are trademarks of AppWork GmbH. The extension is based on the official extension, ported to run under Manifest V3.

## Features

- **Add links from anywhere**: context menu entry (simple or detailed), toolbar popup and in-page toolbar to collect and review links before sending them.
- **Click'n'Load**: intercepts Click'n'Load requests (`XHR`, `fetch`, `form.submit()`) to `127.0.0.1:9666/flash/*` and forwards them to MyJDownloader, so sites such as filecrypt.cc work without a locally running JDownloader.
- **Clipboard observer**: collects copied links automatically (`Ctrl+Shift+X` toggles it).
- **Auto-grab** hotkey (`Ctrl+Shift+Y`).
- **Captcha solving** in the browser (reCAPTCHA / hCaptcha) with the enhanced MyJDownloader captcha dialog.
- **`jdcheck.js` emulation**, so web pages detect JDownloader as available.
- Languages: English, German, Spanish.

## What is different from the official extension

- Runs on a **service worker** instead of a persistent background page.
- The "connected" state is derived from the stored session, so the toolbar badge no longer shows a yellow `!` after the service worker restarts.
- Hardened reconnect handling in the bundled API client: no endless waiting on the reconnect lock, and a short network outage no longer logs you out.
- The `fetch` interceptor does not make failures of the visited page show up on the extension's error page.
- Own extension ID and update channel (see below).

## Installation

### Load unpacked (recommended for development)

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Open the extension popup and log in with your MyJDownloader account.

The extension ID is fixed by the `key` in `manifest.json`:

```
fmkbdabocafmlifkegdbglpijpdmnomk
```

Because the ID differs from the official extension, it has its own storage: you need to log in once, and the official extension should be disabled to avoid conflicts (context menu, Click'n'Load, `jdcheck.js`).

### Packed `.crx` and automatic updates

Chrome on Windows and macOS only installs extensions from outside the Chrome Web Store via enterprise policy. A packed `myjdownloader-mv3.crx` is attached to each [release](../../releases). `update_url` in the manifest points to [`updates.xml`](updates.xml) in this repository.

To install and auto-update through policy, add the extension ID and update URL to `ExtensionInstallForcelist`:

```
fmkbdabocafmlifkegdbglpijpdmnomk;https://raw.githubusercontent.com/steled/myjdownloader-mv3-unofficial/main/updates.xml
```

## Building a release

```bash
# 1. copy the tracked files without .git, *.pem, updates.xml and .gitignore
# 2. pack with the private key (keep myjd-mv3.pem secret, it is git-ignored)
chrome --pack-extension=<clean-copy> --pack-extension-key=myjd-mv3.pem
```

Then upload the `.crx` to a GitHub release named `v<version>` and bump `version` in both `manifest.json` and `updates.xml`.

The private key `myjd-mv3.pem` determines the extension ID. If it is lost, a new key means a new ID and a new storage for all users. Back it up.

## Project layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 definition, permissions, content scripts |
| `background.js` | Service worker: context menu, request queue, badge, captcha and Click'n'Load messaging |
| `contentscripts/` | In-page scripts (toolbar, selection, Click'n'Load interceptor and relay, captcha helpers) |
| `scripts/`, `partials/`, `popup.html` | AngularJS popup and options UI |
| `vendor/js/jdapi.js` | MyJDownloader API client |
| `res/jdcheck.js` | Served instead of `127.0.0.1:9666/jdcheck.js` through `declarativeNetRequest` |
| `updates.xml` | Chrome update manifest |

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and are written in English, so versions map to [SemVer](https://semver.org/):

| Type | Effect on the version |
| --- | --- |
| `fix:` | patch (`3.3.21` -> `3.3.22`) |
| `feat:` | minor (`3.3.21` -> `3.4.0`) |
| `feat!:` or a `BREAKING CHANGE:` footer | major |
| `docs:`, `chore:`, `build:`, `ci:`, `refactor:`, `test:` | no release needed |

Commits are checked by [commitlint](https://commitlint.js.org) in CI. To check them locally as well, run `npm install` once (needs Node.js); this installs a `commit-msg` hook.

Releases are created by tagging: bump `version` in `manifest.json` and `updates.xml`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag triggers the release workflow.

## Privacy

The extension talks to `api.jdownloader.org` (MyJDownloader), to `my.jdownloader.org` for the web interface enhancements, and to your own JDownloader on `127.0.0.1` for captcha and Click'n'Load. Your session tokens are stored in `chrome.storage.local`. No analytics, no third-party servers.

## Credits

Based on the MyJDownloader browser extension by AppWork GmbH. Thanks to the JDownloader team for the original work.
