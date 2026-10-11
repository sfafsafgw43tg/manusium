/**
 * packages/core/src/report-html.ts
 *
 * Static HTML export of an OctoDetect.su audit report. The output contains no
 * scripts and no external resources (CSP default-src 'none'); every value that
 * comes from the probed page is HTML-escaped because a hostile page could put
 * markup into e.g. its user agent or font names.
 */
import type { AuditReport } from './audit';

/** HTML-escape any value (text and attribute context). */
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Static HTML export (no scripts, no external resources). */
export function renderHtmlReport(r: AuditReport & { target: string }, t: (k: string, p?: Record<string, string | number>) => string): string {
  const rows = r.findings.map((f) => `<tr class="${escapeHtml(f.status)}"><td>${escapeHtml(t(`finding.${f.id}`))}</td><td><code>${escapeHtml(f.value)}</code></td><td>${escapeHtml(t(`fstatus.${f.status}`))}</td><td>${escapeHtml(t(`entropy.${f.entropy}`))}</td><td>${escapeHtml(t(f.whyKey))}${f.fixKey ? `<br><em>${escapeHtml(t(f.fixKey))}</em>` : ''}</td></tr>`).join('\n');
  const cons = r.consistency.map((c) => `<li>${escapeHtml(t(c.key))} <code>${escapeHtml(c.detail)}</code></li>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>OctoDetect.su – ${escapeHtml(r.generatedAt)}</title>
<style>
body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;background:#07161a;color:#e2f3f1;margin:0;padding:32px}
h1{margin:0 0 4px}table{border-collapse:collapse;width:100%;margin-top:16px}td,th{border-bottom:1px solid #1b3d45;padding:8px;text-align:left;vertical-align:top}
th{color:#8fb3b0;font-weight:600}code{font:12px Consolas,monospace;color:#a7f3d0;word-break:break-all}
.exposed td:nth-child(3){color:#fca5a5}.limited td:nth-child(3){color:#fcd34d}.blocked td:nth-child(3){color:#86efac}.unknown td:nth-child(3){color:#8fb3b0}
.risk{display:inline-block;padding:4px 14px;border-radius:14px;border:1px solid #1b3d45;margin-right:8px}.muted{color:#8fb3b0}
</style></head><body>
<h1>OctoDetect.su</h1>
<p class="muted">${escapeHtml(t('report.generated'))}: ${escapeHtml(new Date(r.generatedAt).toLocaleString())} · ${escapeHtml(t(`target.${r.target}`))}</p>
<p><span class="risk">${escapeHtml(t('report.risk'))}: <b>${escapeHtml(t(`risk.${r.risk}`))}</b> (${escapeHtml(r.score)})</span>
<span class="risk">${escapeHtml(t('report.uniqueness'))}: <b>${escapeHtml(t(`uniq.${r.uniqueness}`))}</b></span>
<span class="risk">DNS: ${escapeHtml(t(`leak.${r.dns}`))}</span><span class="risk">WebRTC: ${escapeHtml(t(`leak.${r.webrtc}`))}</span></p>
<p class="muted">${escapeHtml(t('report.disclaimer'))}</p>
<table><thead><tr><th>${escapeHtml(t('report.item'))}</th><th>${escapeHtml(t('report.value'))}</th><th>${escapeHtml(t('report.status'))}</th><th>${escapeHtml(t('report.entropy'))}</th><th>${escapeHtml(t('report.whyFix'))}</th></tr></thead>
<tbody>${rows}</tbody></table>
${cons ? `<h2>${escapeHtml(t('report.consistency'))}</h2><ul>${cons}</ul>` : ''}
<p class="muted">${escapeHtml(t('report.fingerprintHash'))}: <code>${escapeHtml(r.fingerprintHash)}</code></p>
</body></html>`;
}
