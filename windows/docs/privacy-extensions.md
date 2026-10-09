# Privacy extensions and native leak controls

This project supports **authorized privacy, QA, and profile separation**. It does not implement stealth, anti-detection, CAPTCHA bypass, ban evasion, fabricated device identities, or making modified Chromium appear to be an ordinary installation.

## Recommended choices

| Engine | Practical choice | Why | Important limitation |
|---|---|---|---|
| Current Chromium | Official **uBlock Origin Lite** | MV3/DNR-compatible and distributed by the official Chrome Web Store | Narrower filtering than full uBlock Origin; rules update with the extension package |
| Firefox/Gecko | Official **uBlock Origin** | Firefox retains the broader request-filtering APIs used by full uBO | Broad all-site permissions; site breakage and update-supply-chain risk |
| Either | InkBrowser native blocker | Signed app code plus HTTPS filter lists with size checks, SHA-256 metadata, and last-good-copy retention | It is not full uBO and does not provide cosmetic-filter parity |

The two official extension choices are catalogued as **external**, not bundled. Their catalog entries are intentionally not silently installed: the user must install and update them through the official browser store and verify the publisher, extension ID, and version.

## Options evaluated

- **Privacy Badger**: useful behavioral anti-tracking, but overlaps with a blocker and has broad all-site permissions. Keep optional and local learning off by default.
- **NoScript**: strongest as a Firefox-first, default-deny active-content firewall. It can break logins, media, payments, and modern applications; Chromium has reduced capabilities.
- **ClearURLs**: useful on Firefox, but the current official extension is Manifest V2 and is not a durable current Chromium deployment. The app's own deterministic URL cleaner is the safer cross-engine path.
- **LocalCDN / Decentraleyes**: Firefox-focused local resource substitution. Broad permissions, resource-integrity/CORS trade-offs, and limited benefit make them opt-in only; they are not bundled.

## Per-profile integrity rules

1. Each profile gets its own engine directory, cookies, storage, extension storage, and allowlist.
2. Do not load arbitrary ZIP/XPI files or developer-mode builds.
3. Stage updates: verify official publisher/ID/version, review manifest and permission changes, run login/payment/media/iframe/download/restart regressions, then retain a rollback artifact.
4. Store only operational metadata such as extension ID, version, policy state, and aggregate test outcomes. Never log page contents, credentials, browsing history, or full sensitive URLs.
5. A high-privilege extension can read and modify pages by design. Profile isolation reduces cross-profile exposure but does not make a compromised extension safe.

## Native WebGL and network controls

The profile editor now exposes **WebGL exposure** per engine. `Allow native WebGL` preserves compatibility. `Disable WebGL` is an explicit privacy/testing trade-off: Chromium receives `--disable-webgl`; Firefox receives `webgl.disabled=true`. This reduces WebGL surface by disabling it; it does **not** spoof a GPU, canvas, renderer, or device identity, and 3D sites may stop working.

WebRTC and location controls remain engine-specific and are written to the native runtime before launch. They are not anonymity guarantees.

## Sources

- uBlock Origin: <https://github.com/gorhill/uBlock>
- uBlock Origin Lite: <https://github.com/uBlockOrigin/uBOL-home>
- Chrome Manifest V2 timeline: <https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline>
- uBO Lite Chrome listing: <https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh>
- uBO Firefox listing: <https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/>
- Privacy Badger permissions: <https://github.com/EFForg/privacybadger/blob/master/doc/permissions.md>
- NoScript usage and capabilities: <https://noscript.net/usage/>
- ClearURLs permissions: <https://docs.clearurls.xyz/latest/permissions/>
- LocalCDN project: <https://codeberg.org/nobody/LocalCDN>
- Firefox extension permissions: <https://support.mozilla.org/en-US/kb/permission-request-messages-firefox-extensions>
