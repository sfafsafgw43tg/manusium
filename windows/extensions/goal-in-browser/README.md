# GOAL in Browser

A privacy extension for Chromium browsers (Chrome, Edge, Brave, Chromium). Version 0.2.0, Manifest V3.

It blocks ads, trackers and fingerprinting scripts, upgrades pages to HTTPS, and turns off some Chrome features that
send data to web services. Settings and lists stay on the device. The extension sends nothing and collects nothing.

**What it is not.** It is not an anti-detect tool, an anonymity tool, or a way to look like a different device. It does
not change, fake or randomize any value a page can read. It does not hide your IP address. See "Limits" below before you rely on it.

## Presets

Pick a level on the popup or the Settings page. Each option can then be changed on its own; the page shows "Custom" once
the options differ from every preset.

| Option | Standard | Strict | Ultra |
| --- | --- | --- | --- |
| Ads and malware domains | On | On | On |
| Tracker domains | On | On | On |
| Fingerprinting script hosts | On | On | On |
| Upgrade to HTTPS | On | On | On |
| Link pings and CSP reports | On | On | On |
| Block third-party cookies (Chrome setting) | On | On | On |
| Privacy Sandbox ad APIs off (Topics, Protected Audience, ad measurement) | On | On | On |
| Hyperlink auditing off | On | On | On |
| Error-page web service off | On | On | On |
| Search suggestions off | Chrome default | On | On |
| Translation service off | Chrome default | On | On |
| Network prediction off | Chrome default | On | On |
| Tracking-link cleanup (needs access to all sites) | Off | On | On |
| Send Global Privacy Control (needs access to all sites) | Off | On | On |
| Referrer: origin only (needs access to all sites) | Chrome default | On | On |
| WebRTC IP handling | Public interface only | Public interface only | Disable non-proxied UDP |
| Third-party scripts blocked | Off | Off | On |
| Third-party frames blocked | Off | Off | On |
| Clear site data at each browser start | Off | Off | On |
| Send Do Not Track | Off | Off | Off |

"Chrome default" means this extension leaves that setting alone. Turning a preset off, or changing an option, always
puts Chrome's own setting back when this extension had changed it.

Ultra blocks third-party scripts and frames. Many sites will stop working until you add them to the allowlist.

## What each option does

- **Ads, trackers, fingerprinting lists.** Declarative network rules block matching requests. The ads and malware list
  is the StevenBlack hosts file (MIT), pinned by commit. The tracker and fingerprinting lists are small curated files in
  `rules/sources/`.
- **HTTPS upgrade.** A rule rewrites `http://` page loads to `https://`. Pages that are only served over http will fail
  to load. Localhost, IPv4 addresses, IPv6 literals and single-label names (such as `printer`) are not upgraded.
- **Pings and CSP reports.** Blocks `ping` and `csp_report` requests.
- **Third-party scripts and frames (Ultra).** Blocks scripts and frames whose site differs from the page's site.
- **Tracking-link cleanup (Strict and Ultra).** On a page navigation, removes known click and campaign parameters
  (for example `utm_*`, `fbclid`, `gclid`) from the address. Case-sensitive, so names are matched exactly.
- **Global Privacy Control (Strict and Ultra).** Adds the request header `Sec-GPC: 1`. This is a request only. The site
  decides whether to honour it.
- **Referrer origin only (Strict and Ultra).** Sends `Referrer-Policy: strict-origin` when the page's response sets no
  policy of its own. A page that sets its own policy keeps it.
- **Referrer off** (Chrome setting, not in a preset): removes the referrer for every site. Can break logins and payments.
- **Do Not Track.** Sends `DNT: 1`. Most sites ignore it.
- **Third-party cookies.** Chrome's setting, set for all sites. Sites with an exception or a Storage Access API grant can
  still receive cookies.
- **Privacy Sandbox ad APIs.** Topics, Protected Audience (FLEDGE) and ad measurement are set to off. Chrome lets an
  extension only turn these off, so they are never switched on.
- **Hyperlink auditing, error-page web service, search suggestions, translation, network prediction.** Chrome settings.
- **WebRTC IP handling.** Chrome's WebRTC policy.
- **Location and notifications.** Set Chrome's default for all sites to block (or ask). Whether this overrides site
  exceptions you already made is not verified. Check `chrome://settings/content`.
- **Clear site data at start (Ultra).** Removes cookies, cache and site storage for normal websites at browser start.
  You will be signed out of those sites. Installed web apps, extensions, history, passwords and downloads are not
  removed. Best effort.
- **Allowlist.** Sites in the allowlist are excluded from blocking, the HTTPS upgrade and tracking-link cleanup. A domain
  also covers its subdomains. Privacy headers and Chrome settings still apply there.
- **Custom blocked domains.** Blocks these domains on other sites. Never blocks a page you open directly.
- **Toolbar count.** Shows how many requests were matched on the current tab.

The Status section of the popup and the Settings page lists every option with its result: On, Partly on, Off, Skipped
(it needs access you have not given), or Error (with the browser's message). A setting that another extension or a
policy controls is reported as skipped, and this extension does not overwrite it.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `declarativeNetRequest` | Blocks matching requests and rewrites http to https, using rules that run in the browser. No page content is read. [Reference](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) |
| `privacy` | Sets the Chrome settings listed above (cookies, WebRTC, Do Not Track, Privacy Sandbox, services). [Reference](https://developer.chrome.com/docs/extensions/reference/api/privacy) |
| `contentSettings` | Sets the location and notification defaults to block. [Reference](https://developer.chrome.com/docs/extensions/reference/api/contentSettings) |
| `browsingData` | Clears site data at browser start, only when you turn that on. [Reference](https://developer.chrome.com/docs/extensions/reference/api/browsingData) |
| `storage` | Keeps your settings, allowlist, custom list and the last status report in `chrome.storage.local`, on this device. [Reference](https://developer.chrome.com/docs/extensions/reference/api/storage) |
| `activeTab` | Reads the address of the tab you are looking at when you open the popup, to offer the site toggle. [Concept](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) |
| Optional `<all_urls>` | Needed only for the header and address features: Global Privacy Control, the referrer limit and tracking-link cleanup. It is requested only when you turn one of those on, from a click in Settings. It is removed when no selected option needs it. Chrome shows a warning that the extension can read and change data on all sites. |

The extension does not request host access at install. It has no content scripts, no web-accessible resources, no
externally connectable pages, and no `tabs`, `history`, `cookies`, `webRequest` or `scripting` permissions.

## Lists

- **Ads and malware:** StevenBlack/hosts (MIT), commit `2025dea` (full commit in `rules/sources/stevenblack-hosts.json`).
  About 72,500 domains, split into eight rulesets of at most 10,000 rules. The build downloads the file from the GitHub
  API once and checks its git blob ID and SHA-256 against the pin. The file is not committed to Git. The licence is in
  `dist/third-party/`. Other sources merged into that file keep their own terms. See `THIRD_PARTY_NOTICES.md`.
- **Trackers and fingerprinting:** curated, in `rules/sources/`. Written for this project.

The extension never downloads lists while it runs. Lists change only when a newer build is installed. To update the
ads list, change the pin in `rules/sources/stevenblack-hosts.json` (commit, blob ID, SHA-256, domain count) and run
`npm run build`. The build stops if the file does not match the pin.

Chrome allows a limited number of enabled static rules across all extensions. If the browser is full, the ads rulesets
are enabled as far as they fit, and the status line shows how many domains are on.

## Install (Chromium browsers)

Chromium 128 or later is required (Chrome, Edge, Brave and Chromium all qualify).

1. Build the extension. You need Node.js 22 and an internet connection for the first build:

   ```
   cd extensions/goal-in-browser
   npm ci
   npm run build
   ```

   The output is in `dist/`.

2. Open the extensions page:
   - Chrome and Chromium: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the `dist` folder.
5. Pin the GOAL in Browser icon to the toolbar, click it, and pick a level.

Brave has its own built-in shields. Running both is not tested. You may not need this extension in Brave.

Firefox-based browsers, such as LibreWolf, cannot run this extension.

## Limits (read these)

- **Not tested in a real browser.** The code is unit-tested with a fake Chrome API and typechecked against
  `@types/chrome` 0.3.4. The rules, the Chrome settings, the popup, the Settings page and the install steps have not
  been run in Chrome. Treat the first install as a test and check `chrome://extensions` for errors.
- **Fingerprinting is not prevented.** Canvas, WebGL, audio, font and hardware checks are not blocked or changed. Chrome
  offers no supported way to block them without faking values, and this extension does not fake values.
- **Blocking is by domain.** Ads served from the same domain as the page, or from a domain that is not on a list, are
  not blocked. There is no element hiding, so some ad space stays visible.
- **The lists are finite and lag behind.** The tracker list has 42 entries. Full filter lists are much larger.
- **Breakage.** Third-party script and frame blocking (Ultra) breaks many sites. HTTPS upgrade has no http fallback.
  Referrer "none" breaks some logins and payments.
- **Third-party cookies.** Blocking is global, but sites with exceptions or Storage Access API grants may still receive
  cookies.
- **Signals are requests.** Global Privacy Control and Do Not Track are headers. Sites choose whether to honour them.
- **Site permissions** (location, notifications) set Chrome's default for all sites. Their effect on your existing site
  exceptions is not verified.
- **Clear site data at start** is best effort, covers normal websites only, and signs you out of them.
- **Policies and other extensions** can control some Chrome settings. Those are reported as skipped, not overwritten.
- **Toolbar count** is the browser's count of matched rules on the tab. Not verified in a browser.
- **Allowlist** matches domains. It does not follow redirects to other domains.
- **Site toggle.** The popup reads the address of the current tab through `activeTab`. Whether Chrome gives the popup that
  address is not verified. If it does not, the popup says "No web page open"; use the allowlist in Settings instead.
- **Permission warning.** Chrome's warning for the all-sites permission is broad. It is requested only for the features
  listed above.

## Declined, and why

- **Spoofed or randomized values** (user agent, client hints, screen, hardware, fonts, timezone, locale, WebGL,
  canvas, audio, WebRTC addresses). A fabricated value is itself a signal, and a random one is inconsistent with the
  real browser. Brave's "farbling" and LibreWolf's `resistFingerprinting` both change these values in the browser
  itself. This extension cannot do that.
- **Per-site or randomized personas.** They make the browser's identity inconsistent across sites.
- **Automation stealth and multi-account management.** These are for evasion or fraud, and are not built.
- **Blocking all JavaScript.** It breaks most sites. Chrome's own script settings already exist for that.
- **Brave's lists (MPL-2.0), uBlock Origin's lists (GPL-3.0), EasyList** (no licence found on GitHub). Not bundled.
  Only MIT-licensed or project-written lists are shipped.
- **Remote list updates at runtime.** Lists change only through a new build.

## Brave and LibreWolf

Brave and LibreWolf are full browsers. This extension covers some of the same categories, using the extension APIs that
Chromium allows: ad and tracker blocking, fingerprinting script blocking, HTTPS upgrade, third-party cookies, privacy
signals, and Chrome's own privacy settings. It does not match either browser's built-in protections, and it is not a
replacement for them.

## Testing

Run from `extensions/goal-in-browser`:

```
npm run typecheck   # TypeScript against @types/chrome 0.3.4
npm test            # build, then the unit tests (node:test)
```

The tests cover:

- Tracker and ads rules: block, main-frame exclusion, look-alike domains, rule IDs, and the ruleset budget.
- The allowlist and custom list: rules, precedence, and that no page the user opens is blocked by the custom list.
- Privacy signals and site access: GPC and referrer rules are added only with site access, and the extension never
  requests permission on its own.
- Permission scope: the manifest permissions, the README explains each one, no content scripts, no remote code, no
  network calls in the shipped source.
- Privacy settings: set, clear, skip-when-locked, and failure reporting. Ownership is recorded only for settings this
  extension set.
- Message handling: only this extension's own pages can send requests; the startup clear runs only when on.

The build checks that the pinned upstream file matches its hash and domain count. The tests check that every declared
ruleset exists in `dist/`. A real-browser test of the built extension is not included; see "Limits".

## Development

- `npm run lists:fetch`: download and verify the pinned hosts file into `.cache/` (not committed).
- `npm run build`: verify the file, generate the rulesets, compile TypeScript and write `dist/`.
- `npm run icons`: redraw the PNG icons.
- `.cache/` and `dist/` are ignored by Git.

## Changes in 0.2.0

- Added the ads and malware list, link-ping blocking, third-party blocking (Ultra), tracking-link cleanup, Global
  Privacy Control and the referrer limit (site access), and the Privacy Sandbox, auditing, error-page, search, translation
  and network-prediction settings.
- Standard now turns off the Privacy Sandbox ad APIs, link auditing and the error-page web service.
- The HTTPS upgrade no longer upgrades IPv4 addresses, IPv6 literals or single-label names.
- Minimum Chrome version is 128 (needed for the response-header condition).
- Added the `browsingData` permission (clear at start, off unless chosen).
- Fingerprinting rule IDs changed (43 to 45). Rule IDs are unique across all rulesets.
