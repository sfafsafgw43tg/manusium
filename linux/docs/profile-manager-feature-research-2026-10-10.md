# Profile-manager and AVD feature research — 2026-10-10

## Implemented in this patch

The Android camera bridge now returns the host camera count, the exact emulator executable, and the SDK root used for enumeration. The picker combines the browser-visible count with the OS-level count, so a state such as “Windows sees 3 cameras, emulator lists none” is preserved as a diagnostic rather than being reduced to “no camera.” Windows and Linux source trees remain synchronized.

The camera path still follows a strict rule: a camera is offered only when the selected emulator binary lists it and the browser can open it and receive a frame. The app does not guess `webcam0`, silently replace a missing camera, or use a test pattern as a real camera. Host-camera launches use cold-boot flags because stale CameraProvider/DirectShow state can crash the Android Camera app.

## Safe features to add next

Public product documentation consistently describes ordinary profile-manager workflows that fit this project: folders, tags, search/filtering, notes, statuses, clone/archive/restore, bulk lifecycle actions, encrypted per-profile storage, profile transfer/revoke controls, role-based access, activity history, proxy templates, proxy health checks, and screenshots/logs for authorized QA. These are privacy, organization, and testing features—not anti-detection guarantees.

The practical engine plan is:

- Chromium/Electron: isolated sessions, local-only CDP, storage inspection for user-owned profiles, proxy connectivity diagnostics, screenshots, downloads/uploads, and explicit target allowlists.
- Firefox: keep the separate native Firefox/BiDi adapter. Do not claim vendor anti-detect Firefox compatibility unless a documented BiDi endpoint and a real runtime test exist.
- Android: keep AVD lifecycle, adb, emulator logs, cold/warm boot choice, camera/microphone diagnostics, display/locale/timezone/network test settings, and explicit media-device ownership.

## Out of scope

The reviewed products advertise or document fingerprint randomization and identity impersonation involving canvas, WebGL/WebGPU, AudioContext, TLS, fonts, hardware, screen, timezone, language, geolocation, user agent/OS, media devices, device names, and sometimes IMEI or webcam replacement. The project will not add stealth, “undetectable” claims, CAPTCHA solving, ban/restriction evasion, account warming, synchronized third-party actions, liveness/identity bypass, or proxy rotation intended to avoid enforcement. Stock Chromium and Firefox cannot reliably turn all of those signals into an arbitrary internally consistent identity.

## Sources consulted

- Multilogin profile, proxy, Mimic/Stealthfox, Playwright, roles, cloud-phone, and ADB documentation: [1] [2] [3] [4] [5] [6] [7]
- Dolphin Anty profile, folders, teamwork, proxy, API, fingerprint, download, mobile, and terms documentation: [8] [9] [10] [11] [12] [13] [14] [15]
- DICloak profile, proxy, kernel, system requirements, Local API, Browser API, and video-loading documentation: [16] [17] [18] [19] [20] [21]
- AdsPower profile, groups, members, proxy, Local API, examples, downloads, and mobile documentation: [22] [23] [24] [25] [26] [27]

## Verification

The focused Android camera tests pass: **25 tests passed**. Linux TypeScript typecheck passes. No Windows camera hardware was available in this Linux environment, so Windows camera capture remains a required direct verification step.

## References

[1]: https://multilogin.com/help/en_US/browser-profile-setup/how-to-create-and-launch-a-profile-in-multilogin-x "Multilogin profile creation"
[2]: https://multilogin.com/help/en_US/browser-profile-setup/how-to-use-mimic-and-stealthfox "Multilogin Mimic and Stealthfox"
[3]: https://multilogin.com/help/en_US/puppeteer-selenium-and-playwright/playwright-automation-example "Multilogin Playwright automation"
[4]: https://multilogin.com/help/workspace-roles-and-permissions "Multilogin workspace roles"
[5]: https://multilogin.com/help/en_US/profile-settings-proxy-section "Multilogin proxy settings"
[6]: https://multilogin.com/help/en_US/how-to-create-mobile-profiles "Multilogin mobile profiles"
[7]: https://multilogin.com/help/en_US/basic-automation-with-cli/cli-for-adb "Multilogin ADB automation"
[8]: https://docs.dolphin-anty.com/en/working-with-profiles/profile-management-in-dolphin-anty "Dolphin Anty profile management"
[9]: https://docs.dolphin-anty.com/en/teamwork/teamwork-in-dolphin-anty "Dolphin Anty teamwork"
[10]: https://docs.dolphin-anty.com/en/working-with-proxies/check-proxy-in-dolphin-anty "Dolphin Anty proxy checks"
[11]: https://docs.dolphin-anty.com/en/api/basic-automation-dolphin-anty "Dolphin Anty API automation"
[12]: https://docs.dolphin-anty.com/en/working-with-fingerprints/digital-fingerprint-and-profile-settings-in-dolphin-anty "Dolphin Anty fingerprint documentation"
[13]: https://dolphin-anty.com/download/ "Dolphin Anty downloads"
[14]: https://dolphin-anty.com/blog/en/antidetect-browser-for-android-and-ios/ "Dolphin Anty Android and iOS article"
[15]: https://dolphin-anty.com/terms-of-use/ "Dolphin Anty terms"
[16]: https://help.dicloak.com/browser-profiles/ "DICloak browser profiles"
[17]: https://help.dicloak.com/feature-overview-ip-proxies/ "DICloak proxy features"
[18]: https://help.dicloak.com/how-to-modify-the-browser-profile-kernel/ "DICloak browser kernels"
[19]: https://help.dicloak.com/system-requirements-2/ "DICloak system requirements"
[20]: https://help.dicloak.com/dicloak-api-browser-profile-interface/ "DICloak profile API"
[21]: https://help.dicloak.com/browser-api/ "DICloak Browser API"
[22]: https://help.adspower.com/docs/creating_browser_profiles "AdsPower browser profiles"
[23]: https://help.adspower.com/docs/groups "AdsPower groups"
[24]: https://help.adspower.com/docs/members "AdsPower members"
[25]: https://help.adspower.com/docs/Proxy-tag-Random-proxies "AdsPower proxy management"
[26]: https://help.adspower.com/docs/api "AdsPower API"
[27]: https://www.adspower.com/blog/how-to-emulate-mobile-browser-on-pc "AdsPower mobile browser emulation"
