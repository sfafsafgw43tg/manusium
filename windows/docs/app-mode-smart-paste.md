# App window mode and Smart paste

## App window mode

Each profile can enable **App window mode** in Profile Creator/Editor → Browser Settings.

- **Native Chromium:** launches the selected staged runtime with Chromium's `--app=<URL>` mode. The browser page is shown in an app-like window rather than the normal tab strip and omnibox.
- **Native Firefox:** launches the selected Gecko runtime with Firefox's `--kiosk` presentation. This removes normal browser chrome while retaining Firefox's real engine and isolated profile.
- **Electron compatibility:** the trusted in-app shell hides its tabs and toolbar but retains a narrow title strip and window controls. It is not a security boundary and does not change the rendering engine.

The option is persisted per profile and is applied only after the profile is relaunched. There is no silent fallback to another engine. If the selected native runtime is unavailable, the normal missing-runtime error is shown.

App mode is a presentation feature, not an anonymity feature. Websites still see the selected engine's normal platform behavior, and the app-mode window can still be closed with the operating-system window controls.

## Smart paste

**Smart paste in address bar** is enabled by default for newly created profiles and is persisted per profile. It only runs for an explicit paste event in the trusted address bar; it does not monitor or read the clipboard in the background.

When enabled, it:

- removes zero-width characters;
- converts pasted tabs and line breaks to spaces;
- collapses repeated spaces and trims surrounding whitespace;
- removes a matching pair of surrounding quotes or backticks;
- adds `https://` to a pasted `www.example.test` address.

It does not rewrite ordinary typing, inspect clipboard contents before paste, or send clipboard contents to a website. The existing page-context Smart Paste menu remains available for editable page fields, subject to the profile clipboard policy.

## Why these additions are conservative

Public browser-profile products commonly expose app-like windows, per-profile sessions, permissions, proxy controls, and convenience actions. This implementation adds only behavior that has a clear local meaning and can be tested against the actual selected runtime. It does not add CAPTCHA bypass, ban evasion, identity impersonation, hidden remote control, or claims of anonymity.
