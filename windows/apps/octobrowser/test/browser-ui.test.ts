/** Regression coverage for the quiet browser entry surface and Base Chrome mode. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const browser = read('apps/octobrowser/src/renderer/browser.ts');
const browserHtml = read('apps/octobrowser/src/renderer/browser.html');
const launcherHtml = read('apps/octobrowser/src/renderer/launcher.html');
const internal = read('apps/octobrowser/src/internal/internal.ts');
const tabPreload = read('apps/octobrowser/src/preload/tab.ts');
const runtime = read('apps/octobrowser/src/main/runtime.ts');
const windowController = read('apps/octobrowser/src/main/window.ts');
const browserCss = read('apps/octobrowser/src/renderer/browser.css');
const launcherProfiles = read('apps/octobrowser/src/renderer/launcher-profiles.ts');
const launcher = read('apps/octobrowser/src/renderer/launcher.ts');
const launcherUi = read('apps/octobrowser/src/renderer/launcher-ui.ts');
const launcherCss = read('apps/octobrowser/src/renderer/launcher.css');
const launcherBg = read('apps/octobrowser/src/renderer/launcher-backup.ts');
const saveCardMain = read('apps/octobrowser/src/main/save-card.ts');
const saveCardUi = read('apps/octobrowser/src/renderer/save-card.ts');
const saveCardHtml = read('apps/octobrowser/src/renderer/save-card.html');
const saveCardCss = read('apps/octobrowser/src/renderer/save-card.css');
const chromePreload = read('apps/octobrowser/src/preload/chrome.ts');
const pageShim = read('apps/octobrowser/src/preload/page-shim.ts');
const sessionPrivacy = read('packages/shell/src/session-privacy.ts');
const mediaPlugins = read('packages/core/src/media-plugins.ts');
const profiles = read('packages/core/src/profiles.ts');
const launcherEditor = read('apps/octobrowser/src/renderer/launcher-editor.ts');
const fingerprintAudit = read('apps/octobrowser/src/main/fingerprint-audit.ts');
const fingerprintProbe = read('apps/octobrowser/src/main/fingerprint-probe.ts');
const fingerprintAuditUi = read('apps/octobrowser/src/renderer/launcher-fingerprint-audit.ts');
const fingerprintTestSites = read('apps/octobrowser/src/shared/fingerprint-test-sites.ts');
const manager = read('apps/octobrowser/src/main/manager.ts');
const i18nEn = read('packages/core/src/i18n/en.ts');
const i18nPl = read('packages/core/src/i18n/pl.ts');

describe('browser entry UI', () => {
  it('uses three balanced titlebar controls and an icon-only launcher brand', () => {
    for (const code of [browserHtml, launcherHtml, browser, launcher]) {
      expect(code).not.toContain('windowFullscreen');
    }
    expect(browserCss).toContain('width: 38px; height: 38px;');
    expect(browserCss).toContain('display: grid; place-items: center;');
    expect(launcherCss).toContain('width: 36px; height: 36px;');
    expect(launcherCss).toContain('display: grid; place-items: center;');
    expect(launcher).toContain('brandLogo(28)');
    expect(launcher).not.toContain("class: 'brand-name'");
  });

  it('gives profile popup actions a visible animated hover and focus selection state', () => {
    expect(launcherCss).toContain('.popup-item:hover:not(:disabled), .popup-item:focus-visible');
    expect(launcherCss).toContain('background: var(--accent-bg)');
    expect(launcherCss).toContain('transform: translateX(2px)');
    expect(launcherCss).toContain('box-shadow: inset 2px 0 var(--accent)');
    expect(launcherCss).toContain('.popup-item:hover:not(:disabled) svg');
  });

  it('anchors permission notifications to the security lock and suppresses shutdown races', () => {
    expect(browserCss).toContain('top: 78px;');
    expect(browserCss).toContain('left: 92px;');
    expect(browserCss).toContain('right: auto;');
    expect(browser).toContain('let shuttingDown = false;');
    expect(browser).toContain('if (shuttingDown) return;');
    expect(browser).toContain('shuttingDown = true;');
    expect(browser).toContain('bars.clear();');
    expect(browser).toContain('dismissAllPopouts();');
  });

  it('exposes Chrome-first, Firefox-second, and lightweight Electron Base choices in the creator', () => {
    expect(launcherEditor).toContain("for (const choice of ['chromium', 'firefox', 'electron'] as const)");
    expect(launcherEditor).toContain("d.engine = choice === 'chromium' ? 'inkbrowser' : choice");
    expect(launcherEditor).toContain("d.browserShell = choice === 'chromium' ? 'chrome' : choice === 'firefox' ? 'firefox' : 'octo'");
    expect(launcherEditor).toContain("['manual', t('fp.v.manual')]");
    expect(launcherEditor).toContain("['off', t('fp.v.off')]");
    expect(manager).toContain("browserEngineFor(p.engine) === 'firefox'");
    expect(manager).toContain("patch.fingerprint = { ...patch.fingerprint, enabled: false }");
    expect(manager).toContain("clean.fingerprint = { ...fingerprint, enabled: false }");
    expect(i18nEn).toContain("'browserEngine.firefoxNote':");
  });

  it('labels native fingerprint values as stored drafts and keeps Chromium runtime controls Chromium-only', () => {
    expect(launcherEditor).toContain("t('enginePrivacy.nativeDraft')");
    expect(launcherEditor).toContain('native-fingerprint-draft');
    expect(launcherEditor).toContain("d.engine === 'inkbrowser' ? [field('browserEngine.chromiumVersion'");
    expect(launcherEditor).toContain("d.engine === 'firefox'\n    ? [['firefox', t('identity.firefox')]");
    expect(i18nEn).toContain("'enginePrivacy.nativeApplied':");
    expect(i18nPl).toContain("'enginePrivacy.nativeDraft':");
  });

  it('routes running Chromium profiles to the native tab controller from the launcher menu', () => {
    expect(launcherProfiles).toContain("browserEngineFor(p.engine) === 'inkbrowser'");
    expect(launcherProfiles).toContain("'mgr:native-tabs', p.id");
    expect(launcherProfiles).toContain("'mgr:native-tab-new', p.id");
    expect(manager).toContain("handle('mgr:native-tab-action'");
    expect(manager).toContain('NativeChromiumTabs.connect(debugPort)');
  });

  it('uses a compact functional shell menu without a fake Octo account badge', () => {
    expect(browser).not.toContain("$('octoAccount')");
    expect(browser).toContain('function renderChromeMenu()');
    expect(browser).toContain("item(t('menu.newPrivateWindow')");
    expect(browser).toContain("item(t('panel.addons')");
    expect(browser).toContain("api.invoke('ui:close-window')");
  });

  it('does not nag on ordinary canvas reads and silently enforces Strict mode', () => {
    expect(pageShim).not.toContain("detail: { type: 'canvas-access' }");
    expect(tabPreload).not.toContain("ipcRenderer.invoke('page:canvas-access'");
    expect(pageShim).toContain("if (c.canvas === 'block-readback')");
    expect(pageShim).toContain('blankLike');
  });

  it('uses compact retractable drawers without blacking out the live page', () => {
    expect(browser).toContain("mk('stMenu', 'menu', 'ui.menu', toggleChromeMenu)");
    expect(browser).toContain("panelElement.classList.remove('hidden', 'popout')");
    expect(browser).toContain('panelCoversContent = false');
    expect(browser).toContain('password-saving-toggle');
    expect(browserCss).toContain('.chrome-menu { position: fixed');
    expect(browserCss).toContain('Every browser tool—including Passwords, Downloads and Settings—is a compact');
    expect(browserCss).not.toContain('#panel.popout');
    expect(browserCss).not.toContain(':root[data-chrome-look="on"] .chrome-menu {');
  });

  it('keeps Windows Sandbox controls out of normal browser and new-tab surfaces', () => {
    for (const code of [browser, internal, tabPreload, runtime]) {
      expect(code).not.toContain('sandbox-relaunch');
      expect(code).not.toContain('internal:sandbox');
    }
    expect(browser).not.toContain('stSandbox');
    expect(internal).not.toContain('api.sandbox');
    expect(internal).not.toContain("'tiles'");
  });

  it('retains the native close path for the Base Chrome Exit command', () => {
    expect(runtime).toContain("handle('ui:close-window'");
    expect(runtime).toContain('this.windowFor(e).close()');
  });

  it('keeps the page visible beside the menu and covers it only for the close countdown', () => {
    expect(browser).toContain("document.body.classList.add('menu-open')");
    expect(browserCss).toContain('body.menu-open #content');
    expect(browser).toContain('setContentCovered(true);');
    expect(browser).toContain("const end = Date.now() + 3_000;");
    expect(browser).toContain("t('close.countdown'");
  });

  it('keeps stable normal-sized tabs and uses reduced-motion-aware browser animation', () => {
    expect(browser).toContain("prefers-reduced-motion: reduce");
    expect(browser).toContain('playClosingTabMotion');
    expect(browser).toContain('TAB_MOTION_DURATION = 220');
    expect(browser).toContain('TAB_MOTION_EASING');
    expect(browserCss).toContain('flex: 0 1 220px');
    expect(browserCss).toContain('width: 220px');
    expect(browserCss).toContain('#tabs { display: flex; gap: 2px; min-width: 0; flex: 0 1 auto;');
    expect(browserHtml.indexOf('id="newTab"')).toBeGreaterThan(browserHtml.indexOf('id="tabs"'));
    expect(browserHtml.indexOf('class="drag"')).toBeGreaterThan(browserHtml.indexOf('id="newTab"'));
    expect(browserCss).toContain('@keyframes browser-pop');
  });

  it('uses a controlled, cleanup-safe tab drag instead of a native drag ghost', () => {
    expect(browser).not.toContain("draggable: 'true'");
    expect(browser).not.toContain("setData('text/octo-tab'");
    expect(browser).toContain('beginTabPointerDrag');
    expect(browser).toContain("window.addEventListener('pointercancel'");
    expect(browser).toContain("window.addEventListener('blur'");
    expect(browser).toContain("source.addEventListener('lostpointercapture'");
    expect(windowController).toContain("case 'detach': this.rt.detachTab");
    expect(windowController).toContain('detachTabTo(id: number, target: BrowserWindowController)');
    expect(runtime).toContain('const target = this.openWindow([], true)');
    expect(browserCss).toContain('.tab-drag-ghost');
  });

  it('lets Chrome tabs occupy the title overlay and renders handset profiles with compact chrome', () => {
    expect(windowController).toContain('private readonly titleOverlayHeight = 0');
    expect(windowController).toContain('this.chrome.setBackgroundColor(frameColor)');
    expect(runtime).toContain('mobile: Boolean(this.mobile)');
    expect(browser).toContain('const usesVerticalTabs');
    expect(browserCss).toContain('data-mobile-chrome="on"');
  });

  it('shows each shell in the profile row and routes selected capture inputs by origin-local id', () => {
    expect(launcherProfiles).toContain('profile.browserShell.${p.browserShell}');
    expect(launcherProfiles).not.toContain('shell-badge shell-${p.browserShell}');
    expect(launcherProfiles).toContain("class: 'kind shell-name'");
    expect(pageShim).toContain("item.kind === 'videoinput' && normalizedLabel(item.label) === normalizedLabel(c.cameraLabel)");
    expect(pageShim).toContain("item.kind === 'audioinput' && normalizedLabel(item.label) === normalizedLabel(c.microphoneLabel)");
    expect(pageShim).toContain("throw new DOMException('The selected camera or microphone is unavailable', 'NotFoundError')");
    expect(pageShim).toContain("method(proto('MediaStreamTrack'), 'applyConstraints'");
    expect(pageShim).toContain('if (alreadySelected) return first');
    expect(pageShim).toContain('delete video.deviceId');
    expect(pageShim).toContain('setTimeout(resolve, 250)');
    expect(pageShim).toContain('setTimeout(resolve, 500)');
    // Manual fingerprint counts cannot hide a concrete profile selection from
    // a website before it gets a chance to call getUserMedia.
    expect(pageShim).toContain("Math.max(want.videoInputs, c.cameraLabel ? 1 : 0)");
    expect(pageShim).toContain("['videoinput', ordered('videoinput', c.cameraLabel)]");
    expect(runtime).toContain("...(allowed.mediaCapture.cameraLabel ? { camera: true } : {})");
    expect(runtime).toContain('await this.controller.update(this.profile)');
    expect(sessionPrivacy).toContain("policy === 'ask' && this.grants.get(`${requestingOrigin}|${k}`) !== false");
    expect(sessionPrivacy).toContain("value.includes('video')");
    expect(sessionPrivacy).toContain("value.includes('audio')");
    expect(runtime).toContain('w.applyMediaCaptureSelection()');
    expect(windowController).toContain('applyMediaCaptureSelection(): void');
    expect(windowController).toContain('tabConfigForContents(wcId: number): PageConfig | null');
    expect(runtime).toContain("ipcMain.on('octo:get-tab-config'");
    expect(tabPreload).toContain("ipcRenderer.sendSync('octo:get-tab-config')");
    expect(sessionPrivacy).toContain("case 'camera':");
    expect(sessionPrivacy).toContain("case 'microphone':");
  });

  it('keeps page position while async local data fills in without a blocking loading screen', () => {
    expect(launcher).toContain('const viewScroll = new Map<string, number>()');
    expect(launcher).toContain('restoreViewScroll(targetView, v)');
    expect(launcher).toContain('Async pages paint their structure immediately');
    expect(launcherUi).not.toContain('export function loadingPopout');
    expect(launcherCss).not.toContain('.loading-popout-layer');
  });

  it('uses realistic theme miniatures and a short animated live transition', () => {
    expect(launcher).toContain("class: 'theme-preview-body'");
    expect(launcher).toContain('startViewTransition');
    expect(launcherCss).toContain('::view-transition-new(root)');
  });

  it('keeps media opt-in and provides live browser selection, preview and vStudio preparation', () => {
    expect(mediaPlugins).toContain("'vstudio-mobile': { enabled: false }");
    expect(mediaPlugins).toContain("'vstudio-web': { enabled: false }");
    expect(browser).toContain("mk('stMedia', 'camera'");
    expect(browser).not.toContain('const opensNow = async');
    expect(browser).toContain('const scanDevices = async (revealLabels = false)');
    expect(browser).toContain("control.replaceChildren(new Option(t('media.systemDefault'), ''))");
    expect(browser).toContain('if (root.isConnected) void scanDevices()');
    // Scanning settings never opens every DirectShow camera. One default
    // permission stream is allowed only after the user presses Refresh.
    expect(browser).toContain('if (revealLabels)');
    expect(browser).toContain('detect.onclick = () => void scanDevices(true)');
    expect(browser).toContain('stopChromeMediaPreview = stop');
    expect(browser).not.toContain('stopChromeMediaPreview === stop');
    expect(browser).toContain("api.invoke('ui:media-preview-released', String(token ?? ''), released)");
    expect(runtime).toContain('if (released) await new Promise((resolve) => setTimeout(resolve, 120))');
    expect(browser).toContain('createAnalyser()');
    expect(browser).toContain("appearance: 'permission'");
    expect(browser).toContain('function syncChromeFront');
    expect(browser).toContain('permissionBarOpen');
    expect(browser).toContain("togglePageInfo");
    expect(browser).toContain("toggleTranslateBar");
    expect(browserHtml).toContain('id="pageInfo"');
    expect(browserHtml).toContain('id="translateBar"');
    expect(browser).toContain("t('perm.wantsTo'");
    expect(browser).toContain("q.kind === 'geolocation' ? 'pin'");
    expect(sessionPrivacy).toContain("this.askPermissionOnce(wc, 'media', origin)");
    expect(sessionPrivacy).toContain('this.askPermissionOnce(wc, k, origin)');
    expect(browserCss).toContain('.bar.permission {');
    expect(browser).toContain("api.invoke('ui:vstudio-web'");
    expect(browser).toContain("placeholder: t('settings.searchSettings')");
  });

  it('uses a cancellation-safe per-profile destination flow and rich download lifecycle', () => {
    expect(sessionPrivacy).toContain('chooseDownloadPath?');
    expect(sessionPrivacy).toContain('chooseDownloadDestination?');
    expect(sessionPrivacy).toContain('item.setSaveDialogOptions');
    expect(sessionPrivacy).toContain("state: 'choosing-location'");
    expect(sessionPrivacy).toContain("if (!selected) { cancel(); return; }");
    expect(sessionPrivacy).toContain('speedBytesPerSecond');
    expect(sessionPrivacy).toContain('safeDownloadSource');
    expect(runtime).toContain('dialog.showSaveDialog');
    expect(runtime).toContain('this.profile.downloads');
    expect(runtime).toContain('lastDirectory: dir');
    expect(browser).toContain("mk('stDownloads', 'download'");
    expect(browser).toContain("openPanel('downloads')");
    expect(browser).toContain("openDownloadsTray");
    expect(browser).toContain("document.body.classList.add('downloads-tray-open')");
    expect(browser).toContain("document.body.classList.remove('downloads-tray-open')");
    expect(browser).toContain("act('dl.retry', 'retry')");
    expect(browserHtml).toContain('id="downloadsTray"');
    expect(browserCss).toContain('.downloads-tray');
    expect(browserCss).toContain('body.downloads-tray-open #content');
    expect(browserCss).toContain('.dl-card');
  });

  it('captures SPA credentials and asks in its own floating card window', () => {
    expect(tabPreload).toContain("document.addEventListener('input'");
    expect(tabPreload).toContain("document.addEventListener('click'");
    expect(tabPreload).toContain('lastPassword');
    // The card is a separate OS window: it is never drawn inside the browser
    // window, so no trusted layer has to sit above the web page any more.
    expect(browserHtml).not.toContain('credentialPrompt');
    expect(browser).not.toContain('showCredentialPrompt');
    expect(saveCardHtml).toContain('id="card"');
    expect(saveCardHtml).toContain('save-card.css');
    expect(saveCardCss).toContain('.save-card-action.primary');
    expect(saveCardUi).toContain("api.on<SaveCardInit>('ui:save-card', render)");
    expect(saveCardUi).toContain("api.invoke(request.channel, { action: 'save'");
    expect(saveCardUi).toContain("answer('never')");
    expect(saveCardUi).toContain("t('pw.never')");
    // Always-on-top, frameless, non-activating: the page keeps the keyboard and
    // touching the browser dismisses the card the way Chrome's bubble does.
    expect(saveCardMain).toContain('frame: false');
    expect(saveCardMain).toContain('alwaysOnTop: true');
    expect(saveCardMain).toContain('skipTaskbar: true');
    expect(saveCardMain).toContain('win.showInactive()');
    expect(saveCardMain).toContain("win.on('blur', () => finish(later()))");
    expect(saveCardMain).toContain("request.parent.on('focus', () => finish(later()))");
    expect(chromePreload).toContain("'ui:save-card'");
    expect(runtime).toContain('openSaveCard({');
    expect(runtime).toContain("if (answer.action === 'never') this.passwords.block(this.profile.id, origin)");
    expect(runtime).toContain('this.disableNativePasswordManager()');
    expect(runtime).toContain('prefs.credentials_enable_service = false');
    expect(runtime).toContain('profile.password_manager_enabled = false');
    expect(profiles).toContain('savePasswords: defaultPasswordSaving(kind)');
    expect(launcherEditor).toContain('savePasswords: savesPasswordsByDefault(kind)');
  });

  it('offers a Backup category that moves profiles between computers', () => {
    // The launcher gains one rail entry, one view and one small card; the
    // file-based transfer reuses the existing encrypted export/import core.
    expect(launcher).toContain("['backup', 'box']");
    expect(launcher).toContain("case 'backup': renderBackup(v); break;");
    expect(launcherUi).toContain("'backup'");
    expect(launcherBg).toContain("h('h1', { text: t('launcher.nav.backup') })");
    expect(launcherBg).toContain("mgr:backup-export");
    expect(launcherBg).toContain("mgr:backup-pick");
    expect(launcherBg).toContain("mgr:backup-import");
    expect(launcherBg).toContain("phraseDisplay(phrase");
    expect(launcherBg).toContain("phraseEntry((complete)");
    expect(launcherCss).toContain('.backup-step');
    expect(manager).toContain("handle('mgr:backup-export'");
    expect(manager).toContain("handle('mgr:backup-pick'");
    expect(manager).toContain("handle('mgr:backup-import'");
    expect(profiles).toContain('async exportBundle(');
    expect(profiles).toContain('async inspectBundle(');
    expect(profiles).toContain('async importBundle(');
    // Both languages describe the same three steps.
    for (const key of ['launcher.nav.backup', 'backup.step1Title', 'backup.step2Title', 'backup.step3Title', 'backup.export', 'backup.import', 'backup.withData', 'backup.note']) {
      expect(i18nEn).toContain(`'${key}'`);
      expect(i18nPl).toContain(`'${key}'`);
    }
  });

  it('keeps a question out of the page so the site stays clickable', () => {
    // A prompt drawn over the page forces the whole chrome above the web view,
    // and from then on every click lands in the chrome - that is the "site
    // became unresponsive" failure. The chrome layer is therefore only raised
    // for panels that really cover content, and the save card is a window.
    expect(browser).toContain('function chromeNeedsFront(): boolean {\n  return !shuttingDown && (pageInfoOpen || translateOpen || chromeMenuOpen || downloadsTrayOpen || passwordsPopoutOpen);\n}');
    expect(browser).not.toContain('|| permissionBarOpen();');
    expect(saveCardMain).toContain('ipcMain.handle(answerChannel');
    expect(saveCardMain).toContain('if (e.sender.id !== cardId) return false;');
    // Every path that hides a surface re-checks the layer state.
    expect(browser).toContain('function watchChromeLayers(): void');
    expect(browser).toContain("observer.observe(bars, { childList: true, subtree: true })");
    expect(browser).toContain('function removeBar(id: string): void');
    expect(browser).not.toContain('bars.delete(b.id); a.run();');
    // Leaving the tab closes the popouts of the tab that had them.
    expect(browser).toContain('dismissAllPopouts();');
    expect(runtime).toContain("w.send(channel, { ...payload, reqId: id, tabId })");
    expect(runtime).toContain("this.firstPasswordOffer(origin, username, password)");
  });

  it('pastes the clipboard in one piece so Smart Paste works in password fields', () => {
    // The old handler typed character by character with a random pause: slow,
    // and it stopped half-way whenever a page re-rendered the field.
    expect(windowController).toContain('wc.insertText(text)');
    expect(tabPreload).toContain("setNativeInputValue(field, next, 'insertFromPaste')");
    expect(tabPreload).toContain('return field.value === next || field.value.includes(value)');
    expect(tabPreload).toContain("document.execCommand('insertText', false, text)");
    expect(tabPreload).not.toContain('const delayFor = (character: string)');
    expect(tabPreload).not.toContain('for (const character of text)');
  });

  it('only offers credential saves after trusted submission signals', () => {
    expect(tabPreload).toContain('function isCredentialSubmitTarget(target: EventTarget | null): Element | null');
    expect(tabPreload).toContain("if (!event.isTrusted) return;");
    expect(tabPreload).toContain("const submit = isCredentialSubmitTarget(target);");
    expect(tabPreload).toContain('Do not offer merely because a password field lost focus');
    expect(tabPreload).toContain('if (type === \'button\' || /show|hide|reveal|toggle|cancel|close|menu|password visibility|eye/.test(raw)) return null;');
  });

  it('features a master-detail floating password manager popout and editable credential prompt', () => {
    expect(browserHtml).toContain('id="passwordsPopout"');
    expect(browserHtml).toContain('id="pwListCol"');
    expect(browserHtml).toContain('id="pwDetailCol"');
    expect(browserCss).toContain('.passwords-popout');
    expect(saveCardCss).toContain('.save-card-input');
    expect(browser).toContain('openPasswordsPopout');
    expect(browser).toContain('renderPasswordsPopout');
    expect(browser).toContain('renderPasswordsDetail');
  });

  it('uses the profile-badged Octo icon for running browser windows', () => {
    expect(windowController).toContain("'profile-running.png'");
    expect(windowController).toContain('iconPath(rt.distDir)');
  });

  it('labels fingerprint values as a configuration preview and offers truthful page read-back', () => {
    expect(launcherEditor).toContain("t('fp.signals.title')");
    expect(launcherEditor).toContain("t('fp.signals.seedPreview')");
    expect(launcherEditor).toContain("t('fp.signals.canvasMode')");
    expect(launcherEditor).toContain("t('fp.signals.webglMode')");
    expect(launcherEditor).toContain("t('fp.signals.audioMode')");
    expect(launcherEditor).toContain("t('fp.signals.webgpuApi')");
    expect(launcherEditor).toContain("t('fp.signals.previewHint')");
    expect(launcherEditor).toContain("t('fp.signals.persistence')");
    expect(launcherEditor).not.toContain("t('fp.signals.canvasHash')");
    expect(launcherEditor).not.toContain("https://browsercheck.net/");
    expect(launcherCss).toContain('.fp-signals-container');
    expect(launcherCss).toContain('.fp-signals-grid');
  });

  it('resets the User-Agent against the current engine without changing the selected OS release', () => {
    const start = launcherEditor.indexOf('uaNew.onclick = async () => {');
    const end = launcherEditor.indexOf('const uaInfoCard', start);
    const handler = launcherEditor.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(handler).toContain('const currentEngine = await meta(os)');
    expect(handler).toContain('fp.uaFullVersion = fullVersion');
    expect(handler).toContain('chromiumUserAgent(fp.os, major)');
    expect(handler).not.toContain('mgr:fingerprint-new');
    expect(handler).not.toContain('fp.platformVersion =');
    expect(handler).toContain("toast(t('fp.uaReset'), 'ok')");
    expect(i18nEn).toContain('legacy User-Agent uses the Windows NT 10.0 token for both Windows 10 and 11');
    expect(i18nEn).toContain("'fp.uaReset': 'User-Agent reset for the current Chromium version.");
    expect(i18nPl).toContain('Windows NT 10.0 zarówno dla Windows 10, jak i 11');
    expect(i18nPl).toContain("'fp.uaReset': 'User-Agent przywrócony dla aktualnej wersji Chromium.");
  });

  it('describes the embedded engine and fingerprint limitations without promising undetectability', () => {
    expect(i18nEn).toContain("'profile.kindDesc.antidetect': 'A browser profile with separate local data and configurable identity settings.");
    expect(i18nEn).toContain('these settings do not guarantee anonymity or prevent detection.');
    expect(i18nPl).toContain('te ustawienia nie gwarantują anonimowości ani ochrony przed rozpoznaniem środowiska.');
    expect(i18nEn).toContain("'fp.newUa': 'Reset to engine-compatible User-Agent'");
  });

  it('labels browser-shell styles separately from the selected native engine', () => {
    expect(i18nEn).toContain("'profile.browserShellDesc.firefox': 'Firefox-compatible");
    expect(i18nEn).toContain("'profile.browserShellDesc.safari': 'Safari-compatible");
    expect(i18nEn).toContain("'profile.browserShellEngine': 'Choose your preferred browser shell interface.");
    expect(i18nPl).toContain("'profile.browserShellEngine': 'Wybierz powłokę interfejsu przeglądarki");
    expect(i18nEn).toContain("'fp.audit.engineNote':");
    expect(i18nPl).toContain("'fp.audit.engineNote':");
    expect(fingerprintAuditUi).toContain("t('fp.audit.engineNote'");
    expect(launcherEditor).toContain("const base = d.engine === 'firefox' ? 'firefox' : d.engine === 'electron' ? 'electron' : 'chromium';");
    expect(launcherEditor).toContain("section(t('profile.base'");
  });

  it('defaults new embedded profiles to the full Chrome-style window shell', () => {
    expect(profiles).toContain("const browserShell: BrowserShell = kind === 'tor' ? 'octo' : 'chrome'");
    expect(launcherEditor).toContain("theme: 'dark', browserShell: 'chrome', baseChromeLook: true");
    expect(launcherEditor).toContain("d.browserShell = k === 'tor' ? 'octo' : 'chrome'");
  });

  it('audits actual selected-profile page read-back and keeps limitations explicit', () => {
    expect(fingerprintAuditUi).toContain("t('fp.audit.column.configured')");
    expect(fingerprintAuditUi).toContain("t('fp.audit.column.applied')");
    expect(fingerprintAuditUi).toContain("t('fp.audit.column.received')");
    expect(fingerprintAudit).toContain('buildFingerprintAuditReport');
    expect(fingerprintAudit).toContain("'fp.audit.limitation.noGuarantee'");
    expect(fingerprintProbe).toContain('nav.hardwareConcurrency');
    expect(fingerprintProbe).toContain('enumerateDevices');
    expect(fingerprintProbe).toContain('String.raw`');
    expect(fingerprintProbe).not.toContain('address:');
  });

  it('routes test-site actions through the chosen profile, including launch and unlock', () => {
    expect(launcherProfiles).toContain('runProfileFingerprintAudit(p)');
    expect(launcherProfiles).toContain('openAllProfileFingerprintTests(p)');
    expect(fingerprintTestSites).toContain('https://browserleaks.com/');
    expect(fingerprintTestSites).toContain('https://pixelscan.net/');
    expect(manager).toContain('this.ensureDiagnosticChild(profile, passphrase)');
    expect(manager).toContain("'fingerprint-audit'");
    expect(manager).toContain("'open-fingerprint-test-sites'");
    expect(manager).toContain("this.launch(profile.id, { passphrase })");
    expect(manager).toContain("handle('mgr:fingerprint-audit'");
    expect(launcherEditor).toContain('savedFingerprint');
    expect(launcherEditor).toContain("t('fp.audit.unsavedChanges')");
  });

  it('resolves auto locale only after the profile network route is active', () => {
    expect(runtime).toContain('await this.controller.prepareNetwork();');
    expect(runtime).not.toContain("if (this.profile.network.mode !== 'proxy') return undefined");
    expect(windowController).toContain('?hl=${encodeURIComponent(lang)}');
  });

  it('supports custom profile column selection and relative launched date formatting', () => {
    expect(launcherProfiles).toContain('col-settings-btn');
    expect(launcherProfiles).toContain('columnsDialog');
    expect(launcherProfiles).toContain('ALL_PROFILE_COLUMNS');
    expect(launcherProfiles).toContain('getSelectedProfileColumns');
    expect(launcherProfiles).toContain('formatRelativeDateTime');
    expect(launcherProfiles).not.toContain('meta-launched');
    expect(launcherCss).toContain('.col-config-container');
    expect(launcherCss).toContain('.col-chip-row');
    expect(launcherCss).toContain('.shell-best-badge');
    expect(i18nEn).toContain("'ui.customizeColumns': 'Customize columns'");
    expect(i18nPl).toContain("'ui.customizeColumns': 'Dostosuj kolumny'");
    expect(i18nEn).toContain("'time.yesterday': 'Yesterday'");
    expect(i18nPl).toContain("'time.yesterday': 'Wczoraj'");
  });
});

describe('tab right-click dropdown', () => {
  it('opens the Chromium-style dropdown at the cursor instead of the side panel', () => {
    // The tab menu is the shared #chromeMenu dropdown: it floats over the page via the same
    // popup layering, closes on outside click or Escape, and is positioned at the pointer.
    expect(browser).toContain('el.oncontextmenu = (e) => { e.preventDefault(); tabMenu(tab, e); };');
    expect(browser).not.toContain("openPanel('menu'");
    expect(browser).not.toContain('function renderMenu(');
    expect(browser).toContain('function tabMenu(tab: TabState, at: MouseEvent): void {');
    expect(browser).toContain('const rows = tabMenuRows(tab, {');
    expect(browser).toContain("menu.classList.add('tab-menu');");
    expect(browser).toContain('const place = placeTabMenu(');
    expect(browser).toContain('menu.style.transformOrigin = place.origin;');
    expect(browser).toContain('function chromeMenuItem(label: string, run: () => void');
    // Menu rows still go through the layer reconciliation that lifts the chrome over the page.
    expect(browser).toContain('chromeMenuOpen = true;');
    expect(browser).toContain('syncChromeFront();\n  requestAnimationFrame(reportLayout);\n}\n\n/** Runs one tab-menu row.');
    // A tab's dropdown cannot outlive that tab.
    expect(browser).toContain('!s.tabs.some((tab) => tab.id === chromeMenuTabId)) closeChromeMenu();');
  });

  it('pops in with an animation that respects motion settings', () => {
    expect(browserCss).toContain('.chrome-menu.tab-menu {');
    expect(browserCss).toContain('animation: tab-menu-pop .14s');
    expect(browserCss).toContain('@keyframes tab-menu-pop { from { opacity: 0; transform: scale(.94); }');
    // Reduced motion and the VM zero-animation mode already switch off every .chrome-menu animation.
    expect(browserCss).toContain('@media (prefers-reduced-motion:reduce) { .chrome-menu, .downloads-tray');
    expect(browserCss).toContain(':root[data-vm-mode="on"] .chrome-menu,');
    expect(browserCss).toContain(':root[data-animations="off"] .chrome-menu.tab-menu { animation: none; }');
    // Disabled rows look disabled and do not highlight on hover.
    expect(browserCss).toContain('.chrome-menu-item:disabled, .chrome-menu-item:disabled:hover');
  });

  it('keeps the browser-menu placement when the shared menu is used for the overflow menu', () => {
    expect(browser).toContain("menu.removeAttribute('style');");
    expect(browser).toContain("menu.classList.remove('tab-menu');");
    expect(browserCss).toContain('.chrome-menu { position: fixed');
  });

  it('gives every new row, toast and group field a label in both languages', () => {
    for (const key of [
      'tab.close', 'tab.newRight', 'tab.addToGroup', 'tab.moveWindow', 'tab.newSplit', 'tab.closeDuplicates',
      'tab.closeOthers', 'tab.closeRight', 'tab.bookmarkAll', 'tab.useVertical', 'tab.useHorizontal', 'toast.bookmarkedAll',
    ]) {
      expect(i18nEn).toContain(`'${key}'`);
      expect(i18nPl).toContain(`'${key}'`);
    }
  });
});
