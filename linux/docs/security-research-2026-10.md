# Security research and hardening notes (2026-10)

This note records public first-party material reviewed before the final hardening pass. It distinguishes browser-state separation from OS isolation and does not claim anti-detect products provide anonymity or guaranteed acceptance.

## Findings applied to this project

- Keep profile data separated with restrictive filesystem permissions and clean up only after the engine process exits.
- Bind native control endpoints to loopback only; do not expose CDP, BiDi, lifecycle APIs, tokens, cookies, or profile exports in logs.
- Preserve browser sandbox/site isolation defaults and do not ship insecure launch flags.
- Use pinned, checksum-verified runtimes and versioned manifests; treat update provenance as a supply-chain boundary.
- Keep fingerprint settings coherent and describe them as privacy/testing controls, not anonymity or ban/CAPTCHA bypass.
- Treat credentials, cookies, exports, proxy secrets, API tokens, and debugger URLs as secrets.

## Evidence boundaries

The consulted anti-detect product documentation describes browser-state separation, fingerprint controls, roles, sharing, sync, or MFA in different combinations. It does not establish a general OS sandbox, hostile-code boundary, debugger authentication model, complete encryption/key-management design, signed update-manifest procedure, or independent security certification for every product. This project therefore does not claim to be “safer than” or feature-equivalent to Dolphin Anty, Multilogin, GoLogin, or DICloak in general.

## Sources

- Multilogin browser profiles and fingerprint settings: https://multilogin.com/help/en_US/browser-profiles and https://multilogin.com/help/en_US/profile-settings-fingerprint-section
- Multilogin cookie export and roles: https://multilogin.com/help/en_US/cookie-export and https://multilogin.com/help/en_US/workspace-roles-and-permissions
- GoLogin profile and sharing model: https://gologin.com/docs/what-is-a-browser-profile.md and https://gologin.com/docs/general/team-collaboration/sharing-profiles.md
- GoLogin data safety and automation: https://gologin.com/docs/general/data-safety.md and https://gologin.com/docs/api-reference/sdks/nodejs-sdk.md
- DICloak profile, API, and runtime guidance: https://help.dicloak.com/create-profile-account/ , https://help.dicloak.com/api-development-guide/ , https://help.dicloak.com/dicloak-runtime-image/
- Dolphin Anty profile, password, API, and security guidance: https://docs.dolphin-anty.com/en/working-with-profiles/creating-and-editing-profiles-in-dolphin-anty and https://docs.dolphin-anty.com/en/faq/authorization-and-security
- Chromium security and Site Isolation: https://www.chromium.org/Home/chromium-security/ and https://www.chromium.org/Home/chromium-security/site-isolation/
- Chrome remote-debugging guidance: https://developer.chrome.com/blog/remote-debugging-port
- Firefox profiles, Primary Password, and fingerprinting: https://support.mozilla.org/en-US/kb/profiles-where-firefox-stores-user-data , https://support.mozilla.org/en-US/kb/use-primary-password-protect-stored-logins , https://support.mozilla.org/en-US/kb/firefox-protection-against-fingerprinting
- Firefox process and update documentation: https://firefox-source-docs.mozilla.org/ipc/processes.html and https://firefox-source-docs.mozilla.org/toolkit/mozapps/update/docs/Implementation.html
