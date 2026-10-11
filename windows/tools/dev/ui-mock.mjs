// tools/dev/ui-mock.mjs - mocked `window.octo` bridge + UI scenarios for ui-shots.mjs.

/** Runs in the page before any script (serialised by puppeteer). */
export function mockSource(mock) {
  const state = JSON.parse(JSON.stringify(mock.state ?? {}));
  const listeners = {};
  const calls = [];
  window.__mock = { state, calls, emit: (ch, p) => (listeners[ch] ?? []).forEach((cb) => cb(p)) };
  const fns = {};
  for (const [k, src] of Object.entries(mock.handlers ?? {})) fns[k] = new Function('state', 'args', 'emit', src);
  window.octo = {
    invoke: async (channel, ...args) => {
      calls.push([channel, args]);
      if (fns[channel]) return JSON.parse(JSON.stringify(fns[channel](state, args, window.__mock.emit) ?? null));
      if (channel in (mock.values ?? {})) return JSON.parse(JSON.stringify(mock.values[channel]));
      return true;
    },
    on: (ch, cb) => { (listeners[ch] ??= []).push(cb); return () => {}; },
  };
  window.octoSetup = window.octo;
}

/** Helpers for scenario steps (run in the page). */
const click = (sel, i = 0) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})][${i}]; if (!el) throw new Error('not found: ' + ${JSON.stringify(sel)}); el.click(); })()`;
const clickText = (sel, text) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())})); if (!el) throw new Error('not found: ' + ${JSON.stringify(text)}); el.click(); })()`;
const type = (sel, value, i = 0) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})][${i}]; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

/** Layout checks: nothing may overflow its box horizontally or overlap a sibling. */
const overlapCheck = `(() => {
  const problems = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  for (const el of document.querySelectorAll('button, input, select, textarea, .kind-card, .run-btn, .seg, .frow-l, h1, h2, h3, .sum-kv, .td')) {
    if (!vis(el)) continue;
    if (el.scrollWidth > el.clientWidth + 2 && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && !el.closest('.ell') && !el.classList.contains('ell') && getComputedStyle(el).overflowX !== 'auto' && getComputedStyle(el).textOverflow !== 'ellipsis') problems.push('overflow: ' + (el.className || el.tagName) + ' "' + el.textContent.trim().slice(0, 40) + '"');
  }
  const groups = ['.toolbar > *', '.seg button', '.kind-grid > *', '.ed-foot > *', '.bulkbar > *', '.tr:not(.th) > .td', '.row-icons > *', '.frow > *', '.grid2 > *', '.grid3 > *', '.side2-head > *', '#nav > *'];
  for (const g of groups) {
    const parents = new Map();
    for (const el of document.querySelectorAll(g)) { if (!vis(el)) continue; const p = el.parentElement; if (!parents.has(p)) parents.set(p, []); parents.get(p).push(el); }
    for (const kids of parents.values()) {
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) problems.push('overlap in ' + g + ': "' + kids[i].textContent.trim().slice(0, 25) + '" / "' + kids[j].textContent.trim().slice(0, 25) + '"');
      }
    }
  }
  const missing = [...document.body.innerText.matchAll(/\\b(?:ui|fp|proxy|api|profile|status|level)\\.[a-zA-Z.]+\\b/g)].map((m) => m[0]).filter((k) => !/^(?:api\\.ipify|proxy\\.cc)/.test(k));
  for (const k of new Set(missing)) problems.push('untranslated key: ' + k);
  return problems;
})()`;

export function scenarios(core) {
  const dicts = core.DICTS;
  const settings = core.defaultSettings ? core.defaultSettings() : {};
  if (core.setEngineVersion) core.setEngineVersion('140.0.7339.133');
  const gen = (os, seed) => core.generateFingerprint({ os, engineMajor: 140, engineFullVersion: '140.0.7339.133', seed });
  const now = Date.now();
  const check = (ok, ip, cc, city, tz) => (ok ? { ok: true, at: new Date(now).toISOString(), ip, country: cc === 'pl' ? 'Poland' : cc === 'de' ? 'Germany' : 'United States', countryCode: cc.toUpperCase(), city, timezone: tz, latencyMs: 180 } : { ok: false, at: new Date(now).toISOString(), error: 'connect ETIMEDOUT' });
  const mk = (kind, name, extra = {}) => ({
    ...core.defaultProfile(kind, name),
    running: false, ready: false, stopping: false, startedAt: 0, sealed: false, hasVault: false, needsResealing: false, issues: [], hasProxyCredentials: false, fingerprintWarnings: [],
    ...extra,
  });
  const profiles = [
    mk('antidetect', 'Shop Warszawa', { fingerprint: gen('windows11', 'a1'), running: true, ready: true, startedAt: now - 3723000, stats: { launches: 12, lastLaunchAt: '', worktimeSec: 34604 }, folder: 'Facebook', status: 'inwork', tags: ['fb', 'ads'],
      network: { mode: 'proxy', proxy: { type: 'socks5', host: 'pl.proxy-example.net', port: 1080, changeIpUrl: '', name: 'PL mobile', savedId: 'sp1' }, hasProxyCredentials: true }, proxyCheck: check(true, '109.241.44.229', 'pl', 'Warsaw', 'Europe/Warsaw') }),
    mk('antidetect', 'Amazon DE', { fingerprint: gen('macos', 'b2'), stats: { launches: 3, lastLaunchAt: '', worktimeSec: 7598 }, folder: 'Amazon', status: 'ready', tags: ['amz'],
      network: { mode: 'proxy', proxy: { type: 'http', host: '185.199.108.20', port: 8080, changeIpUrl: 'https://api.example.com/change?key=1', name: '', savedId: '' }, hasProxyCredentials: true }, proxyCheck: check(true, '185.199.108.20', 'de', 'Frankfurt am Main', 'Europe/Berlin') }),
    mk('antidetect', 'Research US', { fingerprint: gen('linux', 'c3'), stats: { launches: 40, lastLaunchAt: '', worktimeSec: 563438 }, status: 'blocked',
      network: { mode: 'proxy', proxy: { type: 'socks5', host: 'us.rotating-example.io', port: 5000, changeIpUrl: '', name: '', savedId: '' } }, proxyCheck: check(false) }),
    mk('antidetect', 'Nowy profil 4', { fingerprint: gen('windows10', 'd4') }),
    mk('personal', 'Prywatny', { stats: { launches: 100, lastLaunchAt: '', worktimeSec: 120000 } }),
    mk('work', 'Praca', { folder: 'Facebook', stopping: true, running: true, ready: true }),
    mk('tor', 'Tor'),
  ];
  const proxies = [
    { id: 'sp1', name: 'PL mobile', type: 'socks5', host: 'pl.proxy-example.net', port: 1080, hasCredentials: true, changeIpUrl: 'https://pl.proxy-example.net/rotate', createdAt: '', lastCheck: check(true, '109.241.44.229', 'pl', 'Warsaw', 'Europe/Warsaw') },
    { id: 'sp2', name: 'DE datacenter', type: 'http', host: '185.199.108.20', port: 8080, hasCredentials: true, changeIpUrl: '', createdAt: '', lastCheck: check(true, '185.199.108.20', 'de', 'Frankfurt am Main', 'Europe/Berlin') },
    { id: 'sp3', name: '', type: 'socks5', host: '45.13.8.201', port: 4145, hasCredentials: false, changeIpUrl: '', createdAt: '', lastCheck: check(false) },
    { id: 'sp4', name: 'US residential', type: 'http', host: 'gate.us-res-example.com', port: 7000, hasCredentials: true, changeIpUrl: '', createdAt: '' },
  ];
  const init = {
    lang: 'pl', dicts, version: '0.1.0', dataDir: 'C:\\Users\\me\\Documents\\OctoSuite\\OctoBrowser', addons: core.ADDONS, kinds: core.PROFILE_KINDS,
    windowsSandbox: true, torBrowser: false, settings: { ...settings, api: { enabled: true, port: 35555 } }, update: { configured: true, current: '0.1.0', latest: null, available: false, rollbackAvailable: [] },
    logMode: 'standard', filtersUpdatedAt: null, keyringMode: 'os', keyringRequiresPassword: false, secretBackend: 'local', credmanAvailable: true,
  };
  const fps = { windows11: gen('windows11', 'n1'), windows10: gen('windows10', 'n2'), macos: gen('macos', 'n3'), linux: gen('linux', 'n4') };
  const metas = Object.fromEntries(Object.keys(fps).map((os) => [os, { os, gpus: core.gpuPresets(os), userAgent: fps[os].userAgent, engine: { major: 140, full: '140.0.7339.133' } }]));
  const mock = (lang = 'pl') => ({
    state: { profiles, proxies, fps, metas },
    values: { 'mgr:init': { ...init, lang }, 'mgr:api-status': { enabled: true, port: 35555, listening: true, token: 'k3Jd8sP0qLm2Zx9vB7nT4wYc1Re6Ua5H', error: '', baseUrl: 'http://127.0.0.1:35555/v1' },
      'mgr:parse-cookies': { ok: true, count: 3, skipped: 1, format: 'json' },
      'mgr:isolation': [], 'mgr:proxy-check': check(true, '109.241.44.229', 'pl', 'Warsaw', 'Europe/Warsaw') },
    handlers: {
      'mgr:profiles': 'return state.profiles;',
      'mgr:proxies': 'return state.proxies;',
      'mgr:fingerprint-new': 'return state.fps[args[0] || "windows11"];',
      'mgr:fingerprint-meta': 'return state.metas[args[0] || "windows11"];',
      'mgr:close-profile': 'const p = state.profiles.find((x) => x.id === args[0]); p.running = false; p.ready = false; emit("mgr:profiles", state.profiles); return true;',
      'mgr:launch': 'const p = state.profiles.find((x) => x.id === args[0]); p.running = true; p.ready = true; p.startedAt = Date.now(); emit("mgr:profiles", state.profiles); return { status: "started" };',
    },
  });
  const ids = profiles.map((p) => p.id);
  const tab = (id, title, url, extra = {}) => ({ id, title, url, loading: false, audible: false, muted: false, volume: 1, pinned: false, group: '', sleeping: false, blocked: 0, canBack: true, canForward: false, security: url.startsWith('https') ? 'https' : 'internal', crashed: false, zoom: 100, ...extra });
  const priv = core.effectiveSettings ? core.effectiveSettings(core.defaultProfile('antidetect', 'Shop Warszawa').protection) : {};
  const win = { tabs: [tab(1, 'Google', 'https://www.google.com/', { blocked: 3 }), tab(2, 'Allegro – najlepsze ceny', 'https://allegro.pl/'), tab(3, 'OctoDetect', 'octo://detect/')], activeId: 1, splitId: 0, fullscreen: false, closedCount: 0,
    profile: { id: ids[0], name: 'Shop Warszawa', kind: 'antidetect', color: '#2d8cf0', level: 'normal', encrypted: false, sandbox: 'none', network: 'proxy', deleteOnClose: false, audio: { muted: false, volume: 1, outputDeviceId: '' }, addons: [], theme: 'dark' },
    protection: 'active', verticalTabs: false, showBookmarksBar: false, openLinksInBackground: false, offline: false, update: null };
  const bmock = (lang = 'pl') => ({
    state: { win },
    values: { 'ui:init': { lang, dicts, version: '0.1.0', shortcuts: [], addons: core.ADDONS, theme: 'dark' },
      'ui:privacy': { settings: priv, issues: [], profile: win.profile, sandbox: 'none' } },
    handlers: {
      'ui:ready': 'setTimeout(() => emit("ui:state", state.win), 0); return true;',
      'ui:close-request-sim': 'emit("ui:close-request", { tabs: 3, restoreSession: true }); return true;',
    },
  });
  const bshots = [
    { name: 'browser-tabs', page: 'browser.html', mock: bmock(), width: 1280, height: 720, check: overlapCheck },
    { name: 'browser-privacy', page: 'browser.html', mock: bmock(), width: 1280, height: 800, steps: [`new Promise((r) => setTimeout(r, 200))`, click('#stProtection')], check: overlapCheck },
    { name: 'browser-close', page: 'browser.html', mock: bmock(), width: 1280, height: 720, steps: [`new Promise((r) => setTimeout(r, 200))`, `window.octo.invoke('ui:close-request-sim')`], check: `(() => document.getElementById('closeveil').classList.contains('hidden') ? ['close veil not shown'] : [])()` },
  ];
  const sinit = (extra = {}) => ({ app: 'octobrowser', productName: 'Octo.su', version: '0.1.0', langGuess: 'pl', suggestedBase: 'C:\\Users\\me\\Documents\\OctoSuite', siblingConfigured: false, desktopApps: { octobrowser: true, octodetect: true }, dataSubdir: 'OctoBrowser', dpapiAvailable: true, dicts, ...extra });
  const smock = (extra = {}, validate = 'const d = String(args[0] || ""); return d.length < 4 ? { ok: false, errorKey: "firstRun.err.notAbsolute", existing: null } : { ok: true, dataDir: d + "\\\\OctoBrowser", existing: { exists: false } };') => ({
    state: {}, values: { 'setup:init': sinit(extra), 'setup:browse': 'D:\\Dane\\Octo', 'setup:finish': true }, handlers: { 'setup:validate': validate },
  });
  const finishCall = (check) => `(() => { const c = window.__mock.calls.find(([ch]) => ch === 'setup:finish'); if (!c) return ['setup:finish not called']; const a = c[1][0]; const p = []; ${check}; return p; })()`;
  const sshots = [
    { name: 'setup', page: 'shared/firstrun.html', query: '?app=octobrowser', mock: smock(), width: 720, height: 600, check: overlapCheck },
    { name: 'setup-en', page: 'shared/firstrun.html', mock: smock(), width: 720, height: 600, steps: [clickText('#langs button', 'English')], check: `(() => { const p = ${overlapCheck}; if (!/Welcome/.test(document.getElementById('title').textContent)) p.push('title not English'); return p; })()` },
    { name: 'setup-bad-folder', page: 'shared/firstrun.html', mock: smock(), width: 720, height: 600, steps: [type('#baseDir', 'C:'), 'new Promise((r) => setTimeout(r, 450))'], check: `(() => { const p = ${overlapCheck}; if (!document.getElementById('next').disabled) p.push('start enabled for a bad folder'); if (!document.getElementById('folderErr').textContent) p.push('no folder error'); return p; })()` },
    { name: 'setup-browse', page: 'shared/firstrun.html', mock: smock(), width: 720, height: 600, steps: [click('#browse'), 'new Promise((r) => setTimeout(r, 200))'], check: `(() => document.getElementById('baseDir').value === 'D:\\\\Dane\\\\Octo' ? [] : ['browse did not fill the folder: ' + document.getElementById('baseDir').value])()` },
    { name: 'setup-finish', page: 'shared/firstrun.html', mock: smock(), width: 720, height: 600, steps: [click('#ipConsent'), click('#next')], check: finishCall("if (a.keyProtection !== 'os') p.push('keyProtection ' + a.keyProtection); if (a.language !== 'pl') p.push('language ' + a.language); if (a.publicIpLookup !== true) p.push('ip consent lost'); if (a.autoUpdate !== true) p.push('autoUpdate lost'); if (a.masterPassword !== undefined) p.push('password sent')") },
    { name: 'setup-nodpapi', page: 'shared/firstrun.html', mock: smock({ dpapiAvailable: false }), width: 720, height: 600, steps: [click('#next')], check: `(() => { const p = ${overlapCheck}; if (document.getElementById('pwBox').hidden) p.push('password box hidden without DPAPI'); if (window.__mock.calls.some(([c]) => c === 'setup:finish')) p.push('finished without password'); if (!document.getElementById('masterErr').textContent) p.push('no password error'); return p; })()` },
    { name: 'setup-nodpapi-ok', page: 'shared/firstrun.html', mock: smock({ dpapiAvailable: false }), width: 720, height: 600, steps: [type('#masterPw', 'bardzo-dlugie-haslo'), type('#masterPw2', 'bardzo-dlugie-haslo'), click('#next')], check: finishCall("if (a.keyProtection !== 'password') p.push('keyProtection ' + a.keyProtection); if (a.masterPassword !== 'bardzo-dlugie-haslo') p.push('password not sent')") },
    { name: 'unlock', page: 'shared/unlock.html', mock: { state: {}, values: { 'unlock:init': { app: 'octobrowser', productName: 'Octo.su', version: '0.1.0', lang: 'pl', dicts } } }, width: 520, height: 470, check: `(() => { const p = ${overlapCheck}; if (!document.getElementById('password').placeholder) p.push('password placeholder empty'); return p; })()` },
    { name: 'setup-small', page: 'shared/firstrun.html', mock: smock({ dpapiAvailable: false }), width: 640, height: 480, check: overlapCheck },
  ];
  return [
    ...sshots,
    ...bshots,
    { name: 'launcher-profiles', page: 'launcher.html', mock: mock(), check: overlapCheck },
    { name: 'launcher-profiles-en', page: 'launcher.html', mock: mock('en'), check: overlapCheck },
    { name: 'launcher-profiles-narrow', page: 'launcher.html', mock: mock(), width: 1024, height: 700, check: overlapCheck },
    { name: 'launcher-profiles-selected', page: 'launcher.html', mock: mock(), steps: [click('.tbody input[type=checkbox]', 0), click('.tbody input[type=checkbox]', 1)], check: overlapCheck },
    { name: 'launcher-row-menu', page: 'launcher.html', mock: mock(), steps: [click('.c-icons .icon-btn', 1)], check: overlapCheck },
    { name: 'launcher-stop-click', page: 'launcher.html', mock: mock(), steps: [click('.run-btn.stop', 0)], check: `(() => { const p = []; if (!window.__mock.calls.some(([c, a]) => c === 'mgr:close-profile' && a[0] === ${JSON.stringify(ids[0])})) p.push('STOP did not call mgr:close-profile'); if (document.querySelectorAll('.run-btn.stop').length !== 0) p.push('row still shows STOP after close'); return p; })()` },
    { name: 'editor-general', page: 'launcher.html', mock: mock(), height: 900, steps: [click('.toolbar .btn.primary')], check: overlapCheck },
    { name: 'editor-proxy-new', page: 'launcher.html', mock: mock(), height: 900, steps: [click('.toolbar .btn.primary'), `document.querySelector('.ed-main').scrollTop = 99999`, clickText('.proxy-ed .seg button', 'Nowe proxy'), type('.proxy-new .in-wrap input', 'socks5://user:secret@185.199.108.20:1080'), click('.proxy-new .in-btn'), `document.querySelector('.ed-main').scrollTop = 99999`],
      check: `(() => { const p = ${overlapCheck}; const st = document.querySelector('.proxy-status'); if (!st || !st.classList.contains('ok')) p.push('proxy not detected'); const on = document.querySelector('.proxy-new .seg button.on'); if (!on || on.textContent.trim() !== 'SOCKS5') p.push('type chip not switched to SOCKS5: ' + (on && on.textContent)); if (!document.querySelector('.check-card.ok')) p.push('no check result'); return p; })()` },
    { name: 'editor-proxy-bad', page: 'launcher.html', mock: mock(), steps: [click('.toolbar .btn.primary'), clickText('.proxy-ed .seg button', 'Nowe proxy'), type('.proxy-new .in-wrap input', '1.2.3.4:99999'), `document.querySelector('.ed-main').scrollTop = 99999`],
      check: `(() => { const st = document.querySelector('.proxy-status'); return st && st.classList.contains('bad') ? [] : ['bad proxy not flagged']; })()` },
    { name: 'editor-proxy-saved', page: 'launcher.html', mock: mock(), steps: [click('.toolbar .btn.primary'), clickText('.proxy-ed .seg button', 'Zapisane proxy'), `document.querySelector('.ed-main').scrollTop = 99999`], check: overlapCheck },
    { name: 'editor-advanced', page: 'launcher.html', mock: mock(), height: 900, steps: [click('.toolbar .btn.primary'), clickText('.ed-tabs button', 'Zaawansowane')], check: overlapCheck },
    { name: 'editor-advanced-manual', page: 'launcher.html', mock: mock(), height: 1400, steps: [click('.toolbar .btn.primary'), clickText('.ed-tabs button', 'Zaawansowane'), ...[5, 7, 8, 9, 10, 11, 12, 14].map((i) => `(() => { const rows = document.querySelectorAll('.frow'); const r = rows[${i}]; if (!r) return; const b = [...r.querySelectorAll('.seg button')].find((x) => /Ręcznie|Manual/.test(x.textContent)); b && b.click(); })()`)], check: overlapCheck },
    { name: 'editor-advanced-macos', page: 'launcher.html', mock: mock(), steps: [click('.toolbar .btn.primary'), clickText('.ed-tabs button', 'Zaawansowane'), clickText('.seg.big button', 'macOS')],
      check: `(() => { const s = document.querySelector('.sum-kv.ua .v'); return s && s.textContent.includes('Macintosh') ? [] : ['UA not switched to macOS: ' + (s && s.textContent)]; })()` },
    { name: 'editor-browser', page: 'launcher.html', mock: mock(), height: 900, steps: [click('.toolbar .btn.primary'), clickText('.ed-tabs button', 'Przeglądarka')], check: overlapCheck },
    { name: 'editor-edit-existing', page: 'launcher.html', mock: mock(), steps: [click('.name-btn', 0)], check: overlapCheck },
    { name: 'editor-create-call', page: 'launcher.html', mock: mock(), steps: [click('.toolbar .btn.primary'), type('.ed-main input', 'Test 1'), clickText('.proxy-ed .seg button', 'Nowe proxy'), type('.proxy-new .in-wrap input', '1.2.3.4:8080:user:pass'), click('.ed-foot .btn.primary')],
      check: `(() => { const c = window.__mock.calls.find(([ch]) => ch === 'mgr:create'); if (!c) return ['mgr:create not called']; const a = c[1][0]; const p = []; if (a.name !== 'Test 1') p.push('name ' + a.name); if (a.kind !== 'antidetect') p.push('kind ' + a.kind); if (!a.patch.fingerprint || !a.patch.fingerprint.enabled) p.push('no fingerprint'); if (!a.proxy || a.proxy.mode !== 'new' || a.proxy.text !== '1.2.3.4:8080:user:pass') p.push('proxy ' + JSON.stringify(a.proxy)); return p; })()` },
    { name: 'editor-cookies', page: 'launcher.html', mock: mock(), height: 900, steps: [click('.toolbar .btn.primary'), type('.ck-text', '[{"name":"sid","value":"1","domain":".example.com"}]'), 'new Promise((r) => setTimeout(r, 400))', `document.querySelector('.ed-main').scrollTop = 99999`],
      check: `(() => { const p = ${overlapCheck}; if (!document.querySelector('.ck-status.ok')) p.push('no cookie status'); return p; })()` },
    { name: 'editor-cookies-save', page: 'launcher.html', mock: mock(), steps: [click('.toolbar .btn.primary'), type('.ck-text', '[{"name":"sid","value":"1","domain":".example.com"}]'), click('.ed-foot .btn.primary')],
      check: `(() => { const c = window.__mock.calls.find(([ch]) => ch === 'mgr:create'); if (!c) return ['mgr:create not called']; return c[1][0].cookies && c[1][0].cookies.includes('sid') ? [] : ['cookies not sent: ' + JSON.stringify(c[1][0].cookies)]; })()` },
    { name: 'editor-mass', page: 'launcher.html', mock: mock(), height: 1000, steps: [click('.toolbar .btn.primary'), clickText('.ed-tabs button', 'Import masowy'), type('.mass-text', 'Sklep 1;http://user:pass@1.2.3.4:8080\nSklep 2;socks5://5.6.7.8:1080\n9.9.9.9:3128:login:haslo\nZly;1.2.3.4:99999\nTylko nazwa')],
      check: `(() => { const p = ${overlapCheck}; const rows = document.querySelectorAll('.mass-row'); if (rows.length !== 5) p.push('rows ' + rows.length); if (document.querySelectorAll('.mass-row.bad').length !== 1) p.push('bad rows'); if (!/\\(4\\)/.test(document.querySelector('.ed-foot .btn.primary').textContent)) p.push('button: ' + document.querySelector('.ed-foot .btn.primary').textContent); return p; })()` },
    { name: 'editor-mass-create', page: 'launcher.html', mock: mock(), steps: [click('.toolbar .btn.primary'), clickText('.ed-tabs button', 'Import masowy'), type('.mass-text', 'Sklep 1;http://user:pass@1.2.3.4:8080\nSklep 2;socks5://5.6.7.8:1080\n9.9.9.9:3128:login:haslo\nZly;1.2.3.4:99999\nTylko nazwa'), clickText('.mass-ed-os button, .seg button', 'Losowy'), click('.ed-foot .btn.primary'), 'new Promise((r) => setTimeout(r, 400))'],
      check: `(() => { const c = window.__mock.calls.filter(([ch]) => ch === 'mgr:create').map((x) => x[1][0]); const p = []; if (c.length !== 4) p.push('creates ' + c.length); const names = c.map((x) => x.name).join('|'); if (names !== 'Sklep 1|Sklep 2|Profil 3|Tylko nazwa') p.push('names ' + names); if (c[0] && c[0].proxy.text !== 'http://user:pass@1.2.3.4:8080') p.push('proxy0 ' + JSON.stringify(c[0].proxy)); if (c[3] && c[3].proxy.mode !== 'none') p.push('proxy3'); if (c.some((x) => !x.patch.fingerprint)) p.push('no fp'); if (!document.getElementById('modal').classList.contains('hidden')) p.push('dialog still open'); return p; })()` },
    { name: 'proxies', page: 'launcher.html', mock: mock(), steps: [clickText('#nav .rail-item', 'Proxy')], check: overlapCheck },
    { name: 'proxies-add', page: 'launcher.html', mock: mock(), steps: [clickText('#nav .rail-item', 'Proxy'), click('.toolbar .btn.primary'), type('.mass', '1.2.3.4:8080\nhost.pl:1080:login:haslo\nsocks5://u:p@5.6.7.8:1080\nbad line here\nuser:pass@9.9.9.9:3128 [https://rotate.example/ip]')],
      check: `(() => { const ok = document.querySelectorAll('.mp.ok').length, bad = document.querySelectorAll('.mp.bad').length; return ok === 4 && bad === 1 ? [] : ['mass parse ok=' + ok + ' bad=' + bad]; })()` },
    { name: 'api', page: 'launcher.html', mock: mock(), height: 1300, steps: [clickText('#nav .rail-item', 'API')], check: overlapCheck },
    { name: 'settings', page: 'launcher.html', mock: mock(), steps: [clickText('#nav .rail-item', 'Ustawienia')], check: overlapCheck },
  ];
}
