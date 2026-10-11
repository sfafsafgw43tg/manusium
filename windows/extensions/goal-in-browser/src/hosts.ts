/** Hostname rules shared by the allowlist, the custom list and the bundled sources. */

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:xn--[a-z0-9-]{1,59}|[a-z]{2,63})$/;

/**
 * A lowercase hostname with at least one dot, or null. IP addresses, single labels such as
 * "localhost", and non-ASCII names (enter those in punycode) are rejected.
 */
export function normalizeHost(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/\.$/, '');
  return host.length <= 253 && HOSTNAME.test(host) ? host : null;
}

/** The normalized hostname of an http or https URL, or null for any other scheme or host. */
export function siteHost(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return normalizeHost(parsed.hostname);
}

/** True when the host, or a parent domain of it, is in the list. Declarative rules match subdomains too. */
export function isListed(list: readonly string[], host: string): boolean {
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (list.includes(labels.slice(i).join('.'))) return true;
  }
  return false;
}

export function addHost(list: readonly string[], host: string): string[] {
  return [...new Set([...list, host])].sort();
}

export function removeHost(list: readonly string[], host: string): string[] {
  return list.filter((entry) => entry !== host);
}

/** Splits a pasted list into valid domains and the entries that will be ignored. Pure, so it is testable. */
export function parseDomainList(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const entry of text.split(/[\s,;]+/).filter(Boolean)) {
    const host = normalizeHost(entry.replace(/^\*\./, ''));
    if (host) valid.push(host);
    else invalid.push(entry);
  }
  return { valid: [...new Set(valid)], invalid };
}
