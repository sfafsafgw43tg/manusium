/**
 * packages/core/src/proxystore.ts
 *
 * Saved proxies (Proxies page, "Saved proxy" in the profile editor, local API).
 * Metadata lives in config/proxies.json (VersionedStore, backup before every
 * change); usernames/passwords live ONLY in the encrypted SecretStore under
 * "sproxy:<id>".
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { VersionedStore } from './config';
import { DataLayout } from './paths';
import { PROXY_ROTATION_MODES, PROXY_TYPES, ParsedProxy, ProxyCheckResult, ProxyIpObservation, ProxyRotationMode, ProxyType, SavedProxy, appendIpObservation, isValidHost } from './proxy';
import type { SecretStoreApi } from './secretstore';

interface ProxiesDoc { schema: 1; proxies: SavedProxy[] }

function sanitize(v: unknown): SavedProxy | null {
  const p = v as Partial<SavedProxy>;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[a-z0-9-]{3,64}$/.test(p.id)) return null;
  if (!PROXY_TYPES.includes(p.type as ProxyType) || typeof p.host !== 'string' || !isValidHost(p.host)) return null;
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name.slice(0, 64) : '',
    type: p.type as ProxyType,
    host: p.host,
    port,
    hasCredentials: !!p.hasCredentials,
    changeIpUrl: typeof p.changeIpUrl === 'string' && /^https?:\/\/\S+$/.test(p.changeIpUrl) ? p.changeIpUrl.slice(0, 2000) : '',
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    // A zero quota remains the stable, backwards-compatible "unlimited" value.
    usageLimitBytes: Number.isSafeInteger(p.usageLimitBytes) && Number(p.usageLimitBytes) >= 0 && Number(p.usageLimitBytes) <= 10_000_000_000_000_000 ? Number(p.usageLimitBytes) : 0,
    usageBytes: Number.isSafeInteger(p.usageBytes) && Number(p.usageBytes) >= 0 && Number(p.usageBytes) <= Number.MAX_SAFE_INTEGER ? Number(p.usageBytes) : 0,
    lastCheck: p.lastCheck && typeof p.lastCheck === 'object' ? p.lastCheck : undefined,
    folder: typeof p.folder === 'string' ? p.folder.trim().slice(0, 48) : '',
    rotationMode: PROXY_ROTATION_MODES.includes(p.rotationMode as ProxyRotationMode) ? p.rotationMode as ProxyRotationMode : 'auto',
    rotationIntervalSec: Number.isInteger(p.rotationIntervalSec) && Number(p.rotationIntervalSec) >= 0 && Number(p.rotationIntervalSec) <= 86_400 ? Number(p.rotationIntervalSec) : 0,
    ipHistory: Array.isArray(p.ipHistory)
      ? (p.ipHistory as ProxyIpObservation[]).filter((x) => x && typeof x.ip === 'string' && x.ip.length <= 45 && typeof x.at === 'string' && x.at.length <= 40).slice(-8)
      : [],
  };
}

function validate(v: unknown): ProxiesDoc {
  const d = v as Partial<ProxiesDoc>;
  if (!d || d.schema !== 1 || !Array.isArray(d.proxies)) throw new Error('Invalid proxies document');
  return { schema: 1, proxies: d.proxies.map(sanitize).filter((x): x is SavedProxy => !!x) };
}

export class ProxyStore {
  readonly store: VersionedStore<ProxiesDoc>;

  constructor(layout: DataLayout, private readonly secrets?: SecretStoreApi) {
    this.store = new VersionedStore<ProxiesDoc>(path.join(layout.config, 'proxies.json'), {
      backupDir: path.join(layout.backups, 'config'),
      defaults: () => ({ schema: 1, proxies: [] }),
      validate,
      maxBackups: 10,
    });
  }

  list(): SavedProxy[] {
    return this.store.load().proxies;
  }

  get(id: string): SavedProxy {
    const p = this.list().find((x) => x.id === id);
    if (!p) throw new Error(`Proxy not found: ${id}`);
    return p;
  }

  /** Full proxy incl. credentials (for applying to a profile / checking). */
  resolve(id: string): ParsedProxy {
    const p = this.get(id);
    const creds = this.credentials(id);
    return { type: p.type, host: p.host, port: p.port, username: creds.username, password: creds.password, changeIpUrl: p.changeIpUrl };
  }

  credentials(id: string): { username: string; password: string } {
    try {
      const raw = this.secrets?.get(`sproxy:${id}`);
      if (raw) return JSON.parse(raw) as { username: string; password: string };
    } catch { /* damaged entry */ }
    return { username: '', password: '' };
  }

  add(p: ParsedProxy, name = ''): SavedProxy {
    // Same endpoint + user already saved -> return it instead of a duplicate.
    const dup = this.list().find((x) => x.type === p.type && x.host === p.host && x.port === p.port && this.credentials(x.id).username === p.username);
    if (dup) {
      if (p.password) this.secrets?.set(`sproxy:${dup.id}`, JSON.stringify({ username: p.username, password: p.password }));
      return dup;
    }
    const item: SavedProxy = {
      id: `x-${crypto.randomBytes(6).toString('hex')}`,
      name: name.slice(0, 64),
      type: p.type,
      host: p.host,
      port: p.port,
      hasCredentials: !!(p.username || p.password),
      changeIpUrl: p.changeIpUrl,
      createdAt: new Date().toISOString(),
      usageLimitBytes: 0,
      usageBytes: 0,
      folder: '',
      rotationMode: 'auto',
      rotationIntervalSec: 0,
      ipHistory: [],
    };
    if (item.hasCredentials) this.secrets?.set(`sproxy:${item.id}`, JSON.stringify({ username: p.username, password: p.password }));
    this.store.update((d) => { d.proxies.push(item); });
    return item;
  }

  update(id: string, patch: { name?: string; changeIpUrl?: string; usageLimitBytes?: number; lastCheck?: ProxyCheckResult; folder?: string; rotationMode?: ProxyRotationMode; rotationIntervalSec?: number }): SavedProxy {
    let out: SavedProxy | undefined;
    this.store.update((d) => {
      const i = d.proxies.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(`Proxy not found: ${id}`);
      // Callers often send an object with optional fields left undefined; do
      // not turn those into empty/default values while editing another field.
      const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      // A finished check is also an exit-IP observation: it is the only local
      // evidence of whether this endpoint rotates, so it is recorded here.
      const ipHistory = patch.lastCheck ? appendIpObservation(d.proxies[i].ipHistory, patch.lastCheck) : d.proxies[i].ipHistory;
      const merged = sanitize({ ...d.proxies[i], ...definedPatch, ipHistory });
      if (!merged) throw new Error('Invalid proxy');
      d.proxies[i] = merged;
      out = merged;
    });
    return out!;
  }

  /** Add local browser-accounted transfer. The caller decides what traffic is eligible. */
  addUsage(id: string, bytes: number): SavedProxy {
    const delta = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(bytes) || 0)));
    let out: SavedProxy | undefined;
    this.store.update((d) => {
      const current = d.proxies.find((item) => item.id === id);
      if (!current) throw new Error(`Proxy not found: ${id}`);
      const used = Math.min(Number.MAX_SAFE_INTEGER, current.usageBytes + delta);
      const merged = sanitize({ ...current, usageBytes: used });
      if (!merged) throw new Error('Invalid proxy');
      const index = d.proxies.indexOf(current);
      d.proxies[index] = merged;
      out = merged;
    });
    return out!;
  }

  /** Move saved proxies into a folder of the Proxies page ('' = root). */
  setFolder(ids: string[], folder: string): number {
    const clean = folder.trim().slice(0, 48);
    let moved = 0;
    this.store.update((d) => {
      for (const item of d.proxies) {
        if (!ids.includes(item.id) || item.folder === clean) continue;
        item.folder = clean;
        moved++;
      }
    });
    return moved;
  }

  /** Folders that currently hold at least one proxy, alphabetically. */
  folders(): string[] {
    return [...new Set(this.list().map((p) => p.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  remove(id: string): void {
    this.store.update((d) => { d.proxies = d.proxies.filter((x) => x.id !== id); });
    this.secrets?.delete(`sproxy:${id}`);
  }
}
