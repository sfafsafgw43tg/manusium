# Engine-specific privacy controls

Octo.su exposes only controls that the selected native engine receives through its own runtime configuration. The app does not present the legacy Electron fingerprint editor for native Chromium or Firefox profiles.

## Chromium

Native Chromium profiles support:

- **WebRTC: default or disable non-proxied UDP.** This uses the Chromium profile preference `webrtc.ip_handling_policy`.
- **Location: ask or block.** This uses the Chromium profile content-setting preference for geolocation.

The controls are written before launch into the isolated profile directory. No page JavaScript shim is used. Custom user-agent, GPU/WebGL, canvas, font, audio, client-rect, media-device, or device-name substitution is not exposed for native Chromium because this implementation does not apply those values at the engine level.

## Firefox / Gecko

Native Firefox profiles support:

- **WebRTC: default or disabled**, through the Firefox preference `media.peerconnection.enabled`.
- **Location: ask or block**, through `permissions.default.geo`.
- **Resist Fingerprinting: on or off**, through `privacy.resistFingerprinting`.

These are Firefox-native preferences written to the isolated profile's `user.js` before launch. Resist Fingerprinting changes multiple browser-visible values and can cause compatibility problems; it is not a promise of anonymity or acceptance by any site.

## Persistence and reset

The settings are stored in each profile's `enginePrivacy` object. The profile sanitizer rejects unsupported enum values and restores conservative defaults. The editor displays only the selected Base's supported controls. **Reset engine controls** restores default behavior for both engine adapters. Settings are local to a profile and are not copied into another profile by shared mutable state.

Blocking WebRTC can break calls, peer connections, and screen sharing. Blocking location can break maps and local-service workflows. Users should use the normal engine behavior when a site requires those capabilities.

## Research and reuse boundary

The following public materials informed the capability boundary, but no code or proprietary binaries were copied:

- [AntidetectFirefox README](https://github.com/vektort13/AntidetectFirefox) documents Firefox-specific signal substitution and notes that the project is not maintained for normal updates. Its licensing notice is component-specific and reserves Mozilla trademark rights.
- [invisible_puppeteer README](https://github.com/feder-cr/invisible_puppeteer) documents a patched Firefox engine, deterministic profile generation, and SHA-256 engine acquisition. Its wrapper is MIT, while the patched Firefox and other components have separate notices.
- [Camoufox fingerprint documentation](https://camoufox.com/fingerprint/) and [stealth documentation](https://camoufox.com/stealth/) document Firefox C++-level changes and explicitly distinguish them from Chromium/V8 behavior. Its repository documents MPL, MIT, and LGPL component boundaries.
- [Mozilla's Resist Fingerprinting guidance](https://support.mozilla.org/en-US/kb/resist-fingerprinting) describes compatibility trade-offs and recommends regular Fingerprinting Protection for most users.
- [MDN Navigator fingerprinting guidance](https://developer.mozilla.org/en-US/docs/Glossary/Fingerprinting) explains why browser-visible values can be combined for tracking and why a setting is not a security guarantee.
- Public product references were reviewed for design comparison: [Multilogin profile settings](https://multilogin.com/help/en_US/browser-profile-setup/profile-settings-fingerprint-section), [GoLogin fingerprint settings](https://support.gologin.com/en/articles/14810056-profile-fingerprint-settings), [DICloak profile settings](https://help.dicloak.com/create-profile-general-setting/), and [Dolphin Anty fingerprint settings](https://docs.dolphin-anty.com/en/working-with-fingerprints/digital-fingerprint-and-profile-settings-in-dolphin-anty.md).

Those products document many additional substitution controls, but their documentation does not make those controls portable across browser engines or provide a security/acceptance guarantee. Octo.su therefore does not claim feature parity and does not add controls intended to defeat CAPTCHA, bans, access controls, or automation disclosure.
