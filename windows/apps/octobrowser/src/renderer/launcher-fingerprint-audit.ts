import { api } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { FINGERPRINT_TEST_SITES, type FingerprintTestSiteId } from '../shared/fingerprint-test-sites';
import type { FingerprintAuditReport, FingerprintAuditResponse } from '../shared/fingerprint-audit-types';
import { closeModal, errText, modal, toast } from './launcher-ui';
import type { Profile } from './launcher-ui';

export function runProfileFingerprintAudit(profile: Profile): void {
  void request(profile, 'audit');
}

export function openProfileFingerprintTest(profile: Profile, site: FingerprintTestSiteId): void {
  void request(profile, 'sites', [site]);
}

export function openAllProfileFingerprintTests(profile: Profile): void {
  void request(profile, 'sites', Object.keys(FINGERPRINT_TEST_SITES) as FingerprintTestSiteId[]);
}

type Action = 'audit' | 'sites';

async function call(profile: Profile, action: Action, sites: FingerprintTestSiteId[], passphrase?: string): Promise<FingerprintAuditResponse | undefined> {
  try {
    return action === 'audit'
      ? await api.invoke<FingerprintAuditResponse>('mgr:fingerprint-audit', profile.id, passphrase)
      : await api.invoke<FingerprintAuditResponse>('mgr:fingerprint-test-sites', profile.id, sites, passphrase);
  } catch (error) {
    toast(errText(error), 'err');
    return undefined;
  }
}

async function request(profile: Profile, action: Action, sites: FingerprintTestSiteId[] = [], passphrase?: string): Promise<void> {
  const response = await call(profile, action, sites, passphrase);
  if (!response) return;
  if (!response.ok && (response.status === 'need-passphrase' || response.status === 'wrong-passphrase')) {
    promptForPassphrase(profile, action, sites);
    return;
  }
  if (!response.ok) {
    const detail = [response.message || response.status, response.errorFile ? t('fp.audit.errorSaved') : ''].filter(Boolean).join(' · ');
    toast(t('fp.audit.failed'), 'err', detail);
    return;
  }
  if (response.report) {
    showAuditReport(profile, response.report);
    return;
  }
  toast(t('fp.verify.opened', { profile: profile.name }), 'ok', t('fp.verify.openedHint'));
}

function promptForPassphrase(profile: Profile, action: Action, sites: FingerprintTestSiteId[]): void {
  modal(t('fp.audit.passphraseTitle'), (box) => {
    const password = h('input', {
      type: 'password', class: 'input', autocomplete: 'current-password', maxlength: '256',
      placeholder: t('fp.audit.passphrasePlaceholder'), 'aria-label': t('fp.audit.passphraseTitle'),
    }) as HTMLInputElement;
    const error = h('p', { class: 'err', role: 'alert' });
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    const open = h('button', { class: 'btn primary', text: t('fp.audit.continue') }) as HTMLButtonElement;
    const submit = async () => {
      if (open.disabled) return;
      open.disabled = true;
      error.textContent = '';
      const response = await call(profile, action, sites, password.value);
      open.disabled = false;
      password.value = '';
      if (!response) return;
      if (!response.ok && response.status === 'wrong-passphrase') {
        error.textContent = t('fp.audit.wrongPassphrase');
        password.focus();
        return;
      }
      if (!response.ok && response.status === 'need-passphrase') {
        error.textContent = t('fp.audit.passphraseRequired');
        password.focus();
        return;
      }
      closeModal();
      if (!response.ok) {
        const detail = [response.message || response.status, response.errorFile ? t('fp.audit.errorSaved') : ''].filter(Boolean).join(' · ');
        toast(t('fp.audit.failed'), 'err', detail);
        return;
      }
      if (response.report) showAuditReport(profile, response.report);
      else toast(t('fp.verify.opened', { profile: profile.name }), 'ok', t('fp.verify.openedHint'));
    };
    open.onclick = () => void submit();
    password.onkeydown = (event) => { if (event.key === 'Enter') void submit(); };
    cancel.onclick = closeModal;
    box.append(
      h('p', { class: 'hint', text: t('fp.audit.passphraseHint', { profile: profile.name }) }),
      password, error, h('div', { class: 'modal-actions' }, cancel, open),
    );
  });
}

function showAuditReport(profile: Profile, report: FingerprintAuditReport): void {
  const statusKey = `fp.audit.summary.${report.summary}`;
  modal(t('fp.audit.title', { profile: report.profileName || profile.name }), (box) => {
    const summary = h('div', { class: `fp-audit-summary ${report.summary}` },
      h('strong', { text: t(statusKey) }),
      h('span', { text: t('fp.audit.noGuarantee') }),
      h('small', { text: t('fp.audit.timestamp', { time: new Date(report.capturedAt).toLocaleString() }) }));
    const engineNote = h('p', { class: 'hint', text: t('fp.audit.engineNote', {
      shell: t(`profile.browserShell.${profile.browserShell}`),
    }) });
    const table = h('div', { class: 'fp-audit-table-wrap' });
    const grid = h('table', { class: 'fp-audit-table' });
    grid.append(h('thead', {}, h('tr', {},
      h('th', { text: t('fp.audit.column.signal') }),
      h('th', { text: t('fp.audit.column.configured') }),
      h('th', { text: t('fp.audit.column.applied') }),
      h('th', { text: t('fp.audit.column.received') }),
      h('th', { text: t('fp.audit.column.result') }))));
    const body = h('tbody');
    for (const row of report.rows) {
      const result = h('span', { class: `fp-audit-status ${row.status}`, text: t(`fp.audit.status.${row.status}`) });
      body.append(h('tr', {},
        h('th', { scope: 'row', text: t(row.labelKey) }),
        h('td', { text: row.configured }),
        h('td', { text: row.applied }),
        h('td', { text: row.received }),
        h('td', {}, result, row.noteKey ? h('small', { class: 'fp-audit-note', text: t(row.noteKey) }) : null)));
    }
    grid.append(body);
    table.append(grid);
    const limitations = h('ul', { class: 'fp-audit-limitations' });
    for (const key of report.limitations) limitations.append(h('li', { text: t(key) }));
    if (report.errors.length) {
      const errors = h('ul', { class: 'fp-audit-errors' });
      for (const key of report.errors) errors.append(h('li', { text: t('fp.audit.error.generic', { signal: key.replace(/-/g, ' ') }) }));
      box.append(h('div', { class: 'note warn' }, h('strong', { text: t('fp.audit.probeErrors') }), errors));
    }
    const actions = h('div', { class: 'fp-audit-actions row wrap' });
    for (const id of Object.keys(FINGERPRINT_TEST_SITES) as FingerprintTestSiteId[]) {
      const button = h('button', { class: 'btn small', text: t(FINGERPRINT_TEST_SITES[id].labelKey) });
      button.onclick = () => void request(profile, 'sites', [id]);
      actions.append(button);
    }
    const openAll = h('button', { class: 'btn primary small', text: t('fp.verify.openAll') });
    openAll.onclick = () => void request(profile, 'sites', Object.keys(FINGERPRINT_TEST_SITES) as FingerprintTestSiteId[]);
    actions.append(openAll);
    const openErrors = h('button', { class: 'btn small', text: t('fp.audit.openErrors') });
    openErrors.onclick = async () => {
      try { await api.invoke('mgr:open-errors-folder'); }
      catch (error) { toast(errText(error), 'err'); }
    };
    actions.append(openErrors);
    const close = h('button', { class: 'btn', text: t('common.close') });
    close.onclick = closeModal;
    box.append(summary, engineNote, h('p', { class: 'hint', text: t('fp.audit.explanation') }), table,
      h('h3', { text: t('fp.audit.limitationsTitle') }), limitations,
      actions, h('div', { class: 'modal-actions' }, close));
  }, 'xwide');
}
