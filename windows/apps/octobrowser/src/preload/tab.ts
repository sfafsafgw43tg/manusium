/**
 * apps/octobrowser/src/preload/tab.ts
 *
 * Preload for WEB PAGES (every tab and, with nodeIntegrationInSubFrames, every
 * iframe). Runs sandboxed and context-isolated. It:
 *   1. runs page-shim.ts in the page's main world BEFORE page scripts: the
 *      antidetect fingerprint of the profile, or the Strict-preset protections;
 *   2. implements the per-tab volume multiplier and output-device selection
 *      of the audio mixer;
 *   3. provides modern, reliable, framework-compatible password detection,
 *      autofill suggestion overlays, strong password generation, multi-step
 *      credential tracking, and safe Smart Paste handling;
 *   4. exposes a tiny API ONLY to internal octo:// pages (start page, error pages).
 *
 * No globals are added to normal web pages.
 */
import { contextBridge, ipcRenderer } from 'electron';

import { PageConfig, pageShim } from './page-shim';

function readConfig(): PageConfig {
  const fallback: PageConfig = { canvas: 'allow', hw: 'allow', hwValues: { hardwareConcurrency: 4, deviceMemory: 8 }, volume: 1, sinkId: '', cameraLabel: '', microphoneLabel: '', fp: null };
  try {
    const live = ipcRenderer.sendSync('octo:get-tab-config') as Partial<PageConfig> | undefined;
    if (live && typeof live === 'object') return { ...fallback, ...live };
  } catch {
    /* fallback to process.argv */
  }
  const arg = process.argv.find((a) => a.startsWith('--octo-cfg='));
  if (!arg) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(decodeURIComponent(escape(atob(arg.slice('--octo-cfg='.length))))) as Partial<PageConfig>) };
  } catch {
    return fallback;
  }
}

const cfg = readConfig();
const rnd = new Uint8Array(12);
crypto.getRandomValues(rnd);
/** Random, per-page event name for isolated-world -> main-world messages (not guessable by the page). */
const EVENT = `octo-${Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('')}`;

function runInMainWorld(func: (...args: never[]) => unknown, args: unknown[]): void {
  try {
    contextBridge.executeInMainWorld({ func: func as (...a: unknown[]) => unknown, args });
  } catch {
    /* API unavailable - protections for this frame are not active; reported in the privacy panel */
  }
}

runInMainWorld(pageShim as never, [cfg, EVENT]);

// Audio updates pushed by the main process.
ipcRenderer.on('octo:audio', (_e, volume: number, sinkId: string) => {
  runInMainWorld(((name: string, f: number, s: string) => {
    document.dispatchEvent(new CustomEvent(name, { detail: { f, s } }));
  }) as never, [EVENT, volume, sinkId]);
});

// -----------------------------------------------------------------------------
// Framework-safe DOM input value setter (React, Vue, Angular, Svelte compatible)
// -----------------------------------------------------------------------------

function setNativeInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string, inputType = 'insertReplacementText'): void {
  try {
    const beforeEv = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType,
      data: value,
    });
    element.dispatchEvent(beforeEv);
  } catch {
    /* ignore fallback */
  }

  try {
    const proto = Object.getPrototypeOf(element);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (desc && desc.set) {
      desc.set.call(element, value);
    } else {
      element.value = value;
    }
  } catch {
    element.value = value;
  }

  // Clear React synthetic event tracker if present to ensure re-render sync
  try {
    const tracker = (element as unknown as { _valueTracker?: { setValue?: (v: string) => void } })._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      tracker.setValue('');
    }
  } catch {
    /* ignore */
  }

  try {
    const inputEv = new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      composed: true,
      inputType,
      data: value,
    });
    element.dispatchEvent(inputEv);
  } catch {
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }

  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

// -----------------------------------------------------------------------------
// Smart Paste IPC execution in focused input, textarea, contenteditable, or shadow root
// -----------------------------------------------------------------------------

ipcRenderer.on('octo:smart-paste-to-focused', (_e, text: string) => {
  if (typeof text !== 'string' || !text) return;

  function findDeepActiveElement(root: Document | ShadowRoot = document): Element | null {
    let active = root.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  /** Insert one chunk while preserving the field's current selection/caret. */
  const insertInto = (field: HTMLInputElement | HTMLTextAreaElement, value: string): boolean => {
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? field.value.length;
    const next = field.value.slice(0, start) + value + field.value.slice(end);
    setNativeInputValue(field, next, 'insertFromPaste');
    const caret = start + value.length;
    try { field.setSelectionRange(caret, caret); } catch { /* destroyed target */ }
    // Verify: a page that rewrites its own field (formatting, masking, or a
    // validator) can still end up with the text - only an unchanged field
    // means the insert really did not take.
    return field.value === next || field.value.includes(value);
  };

  const insertIntoEditable = (host: HTMLElement, value: string): boolean => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    try {
      // execCommand writes into the selection with the events and undo entry a
      // paste has; it is still the only API that does this in Chromium.
      if (document.execCommand('insertText', false, value)) return true;
    } catch { /* not supported for this element */ }
    try {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(value);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      selection.removeAllRanges();
      selection.addRange(range);
      host.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertFromPaste' }));
      return true;
    } catch { return false; }
  };

  const active = findDeepActiveElement();
  if (!active) return;

  const chunks = text.match(/\S+\s*|\s+/g) ?? [text];
  void (async () => {
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      if (active.disabled || active.readOnly) return;
      for (const chunk of chunks) {
        if (findDeepActiveElement() !== active) return;
        if (!insertInto(active, chunk)) {
          try { active.focus(); } catch { /* ignore */ }
          if (!document.execCommand('insertText', false, chunk)) return;
        }
        // A small word-sized pause makes the operation behave like typing,
        // while remaining fast for normal multi-word text.
        await new Promise<void>((resolve) => window.setTimeout(resolve, chunk.trim() ? 28 : 8));
      }
      return;
    }
    if ((active as HTMLElement).isContentEditable) {
      for (const chunk of chunks) {
        if (findDeepActiveElement() !== active || !insertIntoEditable(active as HTMLElement, chunk)) return;
        await new Promise<void>((resolve) => window.setTimeout(resolve, chunk.trim() ? 28 : 8));
      }
    }
  })();
});

// -----------------------------------------------------------------------------
// Chromium-Parity Password Manager & Autofill Engine
// -----------------------------------------------------------------------------

function installPasswordHelper(): void {
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;

  let lastUsername = '';
  let lastPassword = '';
  let lastNewPassword = '';
  let lastConfirmPassword = '';
  let sessionUsername = ''; // Preserved across multi-step authentication screens
  let lastOffered = '';
  let autofillOverlayHost: HTMLElement | null = null;
  let autofillCloseTimer: number | undefined;
  let activeFocusedInput: HTMLInputElement | null = null;

  function isElementVisible(el: HTMLElement): boolean {
    if (el.hidden || el.style.display === 'none' || el.style.visibility === 'hidden') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity || '1') <= 0.05) return false;
    } catch {
      /* ignore */
    }
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  function collectInputs(root: ParentNode = document): HTMLInputElement[] {
    const list: HTMLInputElement[] = [];
    function scan(node: ParentNode) {
      const inputs = node.querySelectorAll ? [...node.querySelectorAll('input')] : [];
      for (const inp of inputs) {
        if (inp instanceof HTMLInputElement && !inp.disabled && !inp.readOnly && inp.type !== 'hidden') {
          list.push(inp);
        }
        if (inp.shadowRoot) scan(inp.shadowRoot);
      }
      const allElems = node.querySelectorAll ? [...node.querySelectorAll('*')] : [];
      for (const el of allElems) {
        if (el.shadowRoot && !(el instanceof HTMLInputElement)) scan(el.shadowRoot);
      }
    }
    scan(root);
    return list;
  }

  function passwordFields(root: ParentNode = document): HTMLInputElement[] {
    return collectInputs(root).filter((el) => {
      const type = (el.type || '').toLowerCase();
      const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
      return (type === 'password' || auto === 'current-password' || auto === 'new-password') && isElementVisible(el);
    });
  }

  function fieldTokens(el: HTMLInputElement): string {
    const labelled = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent || '' : '';
    return `${el.name || ''} ${el.id || ''} ${el.className || ''} ${el.getAttribute('autocomplete') || ''} ${labelled} ${label}`.toLowerCase();
  }

  function isNewPasswordField(el: HTMLInputElement): boolean {
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (auto === 'new-password') return true;
    const nameId = `${el.name || ''} ${el.id || ''} ${el.className || ''}`.toLowerCase();
    return /new[-_]?password|signup[-_]?password|create[-_]?password|reg[-_]?password|set[-_]?password/.test(nameId);
  }

  function isConfirmPasswordField(el: HTMLInputElement, formInputs: HTMLInputElement[]): boolean {
    const nameId = fieldTokens(el);
    if (/confirm|repeat|retype|password[-_]?confirmation|pass[-_]?2|repeat[-_]?pass/.test(nameId)) return true;
    const pwFields = formInputs.filter((i) => i.type === 'password' || (i.getAttribute('autocomplete') || '').toLowerCase().includes('password'));
    if (pwFields.length > 1 && pwFields[pwFields.length - 1] === el) return true;
    return false;
  }

  function isLikelyUsernameField(el: HTMLInputElement, targetPassword?: HTMLInputElement): boolean {
    const type = (el.type || 'text').toLowerCase();
    if (!['text', 'email', 'tel', ''].includes(type) || !isElementVisible(el)) return false;
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (auto === 'username' || auto === 'email') return true;
    const tokens = fieldTokens(el);
    if (/username|user[-_ ]?id|login|email|e-mail|account|identifier|member|screen[-_ ]?name/.test(tokens)) return true;
    const form = el.form || targetPassword?.form;
    return !!form && passwordFields(form).length > 0;
  }

  function usernameCandidates(root: ParentNode = document, targetPassword?: HTMLInputElement): HTMLInputElement[] {
    const all = collectInputs(root).filter((el) => isLikelyUsernameField(el, targetPassword));
    if (!all.length) return [];
    if (targetPassword) {
      const form = targetPassword.form;
      const scoped = form ? all.filter((i) => i.form === form) : all;
      const before = scoped.filter((el) => (el.compareDocumentPosition(targetPassword) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      if (before.length) return before;
      if (scoped.length) return scoped;
    }
    return all;
  }

  function bestUsernameField(targetPassword?: HTMLInputElement): HTMLInputElement | null {
    const candidates = usernameCandidates(document, targetPassword);
    if (!candidates.length) return null;
    const prioritized = candidates.find((el) => {
      const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (auto === 'username' || auto === 'email') return true;
      return /username|user[-_ ]?id|login|email|account|identifier|member/.test(fieldTokens(el));
    });
    return prioritized ?? candidates[candidates.length - 1] ?? null;
  }

  function bestPasswordField(root: ParentNode, preferred?: HTMLInputElement): HTMLInputElement | null {
    const fields = passwordFields(root);
    if (preferred && fields.includes(preferred) && !isNewPasswordField(preferred)) return preferred;
    const current = fields.filter((field) => !isNewPasswordField(field));
    return current.find((field) => (field.getAttribute('autocomplete') || '').toLowerCase() === 'current-password') || current[0] || fields[0] || null;
  }

  function remember(input: HTMLInputElement): void {
    const type = (input.type || 'text').toLowerCase();
    const val = input.value.trim();
    if (!val) return;

    if (type === 'password' || (input.getAttribute('autocomplete') || '').toLowerCase().includes('password')) {
      const allFormInputs = input.form ? collectInputs(input.form) : collectInputs(document);
      if (isConfirmPasswordField(input, allFormInputs)) {
        lastConfirmPassword = input.value;
      } else if (isNewPasswordField(input)) {
        lastNewPassword = input.value;
        lastPassword = input.value;
      } else {
        lastPassword = input.value;
      }
      const u = bestUsernameField(input)?.value.trim();
      if (u) {
        lastUsername = u;
        sessionUsername = u;
      } else if (sessionUsername) {
        lastUsername = sessionUsername;
      }
    } else if (['text', 'email', 'tel', ''].includes(type)) {
      const auto = (input.getAttribute('autocomplete') || '').toLowerCase();
      const nameId = `${input.name || ''} ${input.id || ''} ${input.placeholder || ''}`.toLowerCase();
      if (auto === 'username' || auto === 'email' || /username|user|login|email|account|ident|nick|member/.test(nameId) || val.includes('@')) {
        lastUsername = val;
        sessionUsername = val;
      }
    }
  }

  let selectedIndex = -1;
  const menuItems: Array<{ el: HTMLElement; action: () => void }> = [];

  function closeAutofillOverlay(): void {
    if (autofillCloseTimer !== undefined) {
      window.clearTimeout(autofillCloseTimer);
      autofillCloseTimer = undefined;
    }
    if (autofillOverlayHost && autofillOverlayHost.parentNode) {
      autofillOverlayHost.parentNode.removeChild(autofillOverlayHost);
    }
    autofillOverlayHost = null;
    activeFocusedInput = null;
    selectedIndex = -1;
    menuItems.length = 0;
  }

  function updateMenuSelection(): void {
    for (let i = 0; i < menuItems.length; i++) {
      if (i === selectedIndex) {
        menuItems[i].el.style.background = '#3b82f6';
        menuItems[i].el.style.color = '#ffffff';
      } else {
        menuItems[i].el.style.background = 'transparent';
        menuItems[i].el.style.color = '#e2e8f0';
      }
    }
  }

  function showAutofillDropdown(
    targetInput: HTMLInputElement,
    accounts: Array<{ id: string; username: string; updatedAt: string }>,
    allowPasswordGen: boolean
  ): void {
    closeAutofillOverlay();
    if (!accounts.length && !allowPasswordGen) return;

    const rect = targetInput.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const host = document.createElement('div');
    host.style.cssText = 'all: initial; position: absolute; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0; pointer-events: auto;';
    const shadow = host.attachShadow({ mode: 'closed' });

    const dropdown = document.createElement('div');
    const topPos = window.scrollY + rect.bottom + 4;
    const leftPos = window.scrollX + rect.left;
    const width = Math.max(220, Math.min(360, rect.width));

    dropdown.style.cssText = `
      position: absolute;
      top: ${topPos}px;
      left: ${leftPos}px;
      width: ${width}px;
      max-height: 260px;
      overflow-y: auto;
      background: #1e2024;
      color: #e2e8f0;
      border: 1px solid #334155;
      border-radius: 8px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4), 0 2px 6px rgba(0, 0, 0, 0.2);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      padding: 4px;
      z-index: 2147483647;
      pointer-events: auto;
      user-select: none;
    `;

    // Account items
    for (const acc of accounts) {
      const item = document.createElement('div');
      item.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 5px;
        cursor: pointer;
        transition: background 0.15s ease;
      `;
      item.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500;">${acc.username ? acc.username.replace(/</g, '&lt;') : 'Saved Account'}</span>
      `;
      const action = () => {
        void fillAccount(acc.id, targetInput);
        closeAutofillOverlay();
      };
      item.onmouseenter = () => {
        selectedIndex = menuItems.findIndex((m) => m.el === item);
        updateMenuSelection();
      };
      item.onmouseleave = () => {
        selectedIndex = -1;
        updateMenuSelection();
      };
      item.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        action();
      };
      dropdown.appendChild(item);
      menuItems.push({ el: item, action });
    }

    // Generate password item
    if (allowPasswordGen) {
      if (accounts.length) {
        const sep = document.createElement('div');
        sep.style.cssText = 'height: 1px; background: #334155; margin: 4px 0;';
        dropdown.appendChild(sep);
      }
      const genItem = document.createElement('div');
      genItem.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 5px;
        cursor: pointer;
        color: #93c5fd;
        font-weight: 500;
        transition: background 0.15s ease;
      `;
      genItem.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;">
          <path d="M21 2l-2 2m-1-1l-2 2m-1-1l-2 2"></path>
          <circle cx="7.5" cy="15.5" r="5.5"></circle>
          <path d="m16 8 5-5"></path>
          <path d="m12 12 4-4"></path>
        </svg>
        <span>Suggest strong password</span>
      `;
      const action = () => {
        void applyGeneratedPassword(targetInput);
        closeAutofillOverlay();
      };
      genItem.onmouseenter = () => {
        selectedIndex = menuItems.findIndex((m) => m.el === genItem);
        updateMenuSelection();
      };
      genItem.onmouseleave = () => {
        selectedIndex = -1;
        updateMenuSelection();
      };
      genItem.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        action();
      };
      dropdown.appendChild(genItem);
      menuItems.push({ el: genItem, action });
    }

    shadow.appendChild(dropdown);
    document.body.appendChild(host);
    autofillOverlayHost = host;
    activeFocusedInput = targetInput;
    host.addEventListener('mouseenter', () => {
      if (autofillCloseTimer !== undefined) {
        window.clearTimeout(autofillCloseTimer);
        autofillCloseTimer = undefined;
      }
    });
    host.addEventListener('mouseleave', () => {
      if (activeFocusedInput === targetInput) {
        autofillCloseTimer = window.setTimeout(closeAutofillOverlay, 1800);
      }
    });
    // The animation is on the isolated dropdown, so it cannot steal focus or
    // alter the page's layout. Respect the user's reduced-motion preference.
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dropdown.animate(
        [{ opacity: '0', transform: 'translateY(-4px) scale(.985)' }, { opacity: '1', transform: 'translateY(0) scale(1)' }],
        { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    }
  }

  async function fillAccount(id: string, targetInput?: HTMLInputElement): Promise<void> {
    const cred = await ipcRenderer.invoke('page:password-fill', { id }) as { username: string; password: string } | null;
    if (!cred) return;

    const root = targetInput?.form ?? document;
    const pwField = bestPasswordField(root, targetInput?.type === 'password' ? targetInput : undefined);
    const uField = bestUsernameField(pwField ?? undefined);

    if (uField && cred.username) setNativeInputValue(uField, cred.username);
    if (pwField && cred.password) setNativeInputValue(pwField, cred.password);
  }

  async function applyGeneratedPassword(targetInput: HTMLInputElement): Promise<void> {
    const res = await ipcRenderer.invoke('page:password-generate') as { password?: string } | null;
    if (!res || !res.password) return;
    const pass = res.password;
    setNativeInputValue(targetInput, pass);

    const root = targetInput.form ?? document;
    const allInputs = collectInputs(root);
    for (const inp of allInputs) {
      if (inp !== targetInput && (inp.type === 'password' || (inp.getAttribute('autocomplete') || '').toLowerCase().includes('password'))) {
        if (isConfirmPasswordField(inp, allInputs)) {
          setNativeInputValue(inp, pass);
        }
      }
    }
  }

  async function handleInputFocus(input: HTMLInputElement): Promise<void> {
    if (input.disabled || input.readOnly || !isElementVisible(input)) return;
    const type = (input.type || 'text').toLowerCase();
    const isPw = type === 'password' || (input.getAttribute('autocomplete') || '').toLowerCase().includes('password');
    const isUser = isLikelyUsernameField(input);
    if (!isPw && !isUser) return;

    const isNewPw = isPw && isNewPasswordField(input);
    const accounts = await ipcRenderer.invoke('page:password-query') as Array<{ id: string; username: string; updatedAt: string }> | null;
    const list = accounts || [];

    if (list.length > 0 || isNewPw) {
      showAutofillDropdown(input, list, isNewPw);
    }
  }

  const offer = (root: ParentNode = document): void => {
    const pws = passwordFields(root).length ? passwordFields(root) : passwordFields(document);
    for (const pw of pws) {
      if (pw.value) remember(pw);
    }

    const effectivePassword = lastNewPassword || lastPassword;
    if (!effectivePassword) return;

    // Check confirmation password consistency if present
    if (lastNewPassword && lastConfirmPassword && lastNewPassword !== lastConfirmPassword) {
      return; // Do not offer to save mismatched passwords
    }

    const effectiveUsername = lastUsername || sessionUsername;
    const signature = `${effectiveUsername}\u0000${effectivePassword}`;
    if (signature === lastOffered) return;
    lastOffered = signature;

    void ipcRenderer.invoke('page:password-offer', { username: effectiveUsername, password: effectivePassword });
  };
  function isCredentialSubmitTarget(target: EventTarget | null): Element | null {
    if (!(target instanceof Element)) return null;
    const control = target.closest('button, input[type="submit"], input[type="image"], [role="button"], a[href]');
    if (!control) return null;
    const form = control instanceof HTMLButtonElement || control instanceof HTMLInputElement ? control.form : control.closest('form');
    const raw = `${control.textContent || ''} ${control.getAttribute('aria-label') || ''} ${control.getAttribute('name') || ''} ${control.getAttribute('id') || ''} ${control.getAttribute('href') || ''}`.toLowerCase();
    const type = control instanceof HTMLButtonElement || control instanceof HTMLInputElement ? (control.getAttribute('type') || '').toLowerCase() : '';
    if (type === 'button' || /show|hide|reveal|toggle|cancel|close|menu|password visibility|eye/.test(raw)) return null;
    if (type === 'submit' || type === 'image') return form ? control : null;
    if (/log[ -]?in|sign[ -]?in|authenticate|verify|continue|next|submit|enter|login/.test(raw)) return form || passwordFields(document).length ? control : null;
    return null;
  }

  // Event Listeners for user actions and form lifecycle
  document.addEventListener('focusin', (event) => {
    if (!event.isTrusted) return;
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      void handleInputFocus(target);
    } else {
      closeAutofillOverlay();
    }
  }, true);

  document.addEventListener('focusout', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      // Keep the native-like menu alive while the pointer/keyboard moves from
      // the field into the isolated menu. The menu's hover handlers cancel this
      // grace timer, and clicking an item still closes it immediately.
      if (autofillCloseTimer !== undefined) window.clearTimeout(autofillCloseTimer);
      autofillCloseTimer = window.setTimeout(() => {
        autofillCloseTimer = undefined;
        if (activeFocusedInput === target) closeAutofillOverlay();
      }, 900);
      // Do not offer merely because a password field lost focus. Many pages
      // validate or reveal credentials before submission; offering here would
      // expose a secret too early and create prompts for abandoned forms.
    }
  }, true);

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      remember(target);
      if (activeFocusedInput === target) closeAutofillOverlay();
    }
  }, true);

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) remember(target);
  }, true);

  document.addEventListener('paste', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      window.setTimeout(() => remember(target), 0);
    }
  }, true);

  document.addEventListener('submit', (event) => {
    if (!event.isTrusted) return;
    const form = event.target;
    if (form instanceof HTMLFormElement) offer(form);
    closeAutofillOverlay();
  }, true);

  document.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const target = event.target;
    if (autofillOverlayHost && !autofillOverlayHost.contains(target as Node)) {
      closeAutofillOverlay();
    }
    const submit = isCredentialSubmitTarget(target);
    if (submit && passwordFields(document).length) {
      offer(document);
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (autofillOverlayHost && menuItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        selectedIndex = (selectedIndex + 1) % menuItems.length;
        updateMenuSelection();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        selectedIndex = (selectedIndex - 1 + menuItems.length) % menuItems.length;
        updateMenuSelection();
        return;
      }
      if (event.key === 'Enter' && selectedIndex >= 0 && selectedIndex < menuItems.length) {
        event.preventDefault();
        event.stopPropagation();
        menuItems[selectedIndex].action();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAutofillOverlay();
        return;
      }
    }

    if (event.key === 'Escape') {
      closeAutofillOverlay();
    } else if (event.isTrusted && event.key === 'Enter') {
      if (passwordFields(document).length) offer(document);
      closeAutofillOverlay();
    }
  }, true);

  window.addEventListener('popstate', () => offer(document), true);
  window.addEventListener('hashchange', () => offer(document), true);
  window.addEventListener('scroll', () => closeAutofillOverlay(), true);
  window.addEventListener('resize', () => closeAutofillOverlay(), true);
  window.addEventListener('beforeunload', () => offer(document), true);

  // Monitor dynamic DOM changes (e.g. SPAs, React login modals, multi-step flows)
  const observer = new MutationObserver(() => {
    const visiblePws = passwordFields(document);
    for (const p of visiblePws) {
      if (p.value) remember(p);
    }
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden'] });
  } catch {
    /* ignore */
  }
}

if (location.protocol === 'https:' || location.protocol === 'http:') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installPasswordHelper, { once: true });
  else installPasswordHelper();
}

// ---- internal pages (octo://newtab, octo://error, octo://https-only) only ----
if (location.protocol === 'octo:') {
  contextBridge.exposeInMainWorld('octoInternal', {
    status: () => ipcRenderer.invoke('internal:status'),
    navigate: (input: string) => ipcRenderer.invoke('internal:navigate', String(input).slice(0, 4096)),
    allowHttp: (url: string) => ipcRenderer.invoke('internal:allow-http', String(url).slice(0, 4096)),
    strings: () => ipcRenderer.invoke('internal:strings'),
  });
}
