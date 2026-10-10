/**
 * packages/shell/src/adblock.ts
 *
 * Network-level ad & tracker blocking with the Ghostery adblocker engine
 * (MPL-2.0). Two engines are kept so a profile can block ads, trackers or both:
 *   ads      <- EasyList + uBlock filters
 *   trackers <- EasyPrivacy + uBlock Privacy
 *
 * Lists are downloaded ONLY from their official HTTPS hosts (FILTER_LISTS),
 * size-limited, sanity-checked (an HTML error/captive-portal page is rejected),
 * hashed (SHA-256 recorded in filters.json) and the last good copy is kept.
 * A small bundled baseline list makes blocking work before the first update.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
// The core engine only (network matching). @ghostery/adblocker-electron is NOT used: it resolves
// its preload script at import time (breaks when bundled) and we do our own webRequest wiring.
import { FiltersEngine, Request } from '@ghostery/adblocker';
import { FILTER_LISTS, FilterListSource, Logger, atomicWriteFile, ensureDir, looksLikeFilterList, sha256Hex } from '@octo/core';

interface FiltersMeta {
  schema: 1;
  updatedAt?: string;
  lists: Record<string, { sha256: string; bytes: number; fetchedAt: string }>;
}

export type BlockCategory = 'ads' | 'trackers';

export interface MatchResult {
  category: BlockCategory | null;
  redirect?: string;
}

/** Minimal fetch signature (Electron net.fetch in production). */
export type ListFetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class AdblockService {
  private ads: FiltersEngine | null = null;
  private trackers: FiltersEngine | null = null;
  private meta: FiltersMeta = { schema: 1, lists: {} };

  constructor(private readonly dir: string, private readonly baselineFile: string, private readonly logger: Logger) {
    ensureDir(dir);
  }

  get updatedAt(): string | undefined {
    return this.meta.updatedAt;
  }

  get ready(): boolean {
    return !!(this.ads || this.trackers);
  }

  private metaFile(): string {
    return path.join(this.dir, 'filters.json');
  }

  private listFile(id: string): string {
    return path.join(this.dir, `${id}.txt`);
  }

  /** Load cached lists (verifying their SHA-256) or the bundled baseline. */
  init(): void {
    try {
      this.meta = JSON.parse(fs.readFileSync(this.metaFile(), 'utf8')) as FiltersMeta;
    } catch {
      this.meta = { schema: 1, lists: {} };
    }
    this.rebuild();
  }

  private readVerified(src: FilterListSource): string | null {
    const f = this.listFile(src.id);
    const m = this.meta.lists[src.id];
    if (!m || !fs.existsSync(f)) return null;
    const text = fs.readFileSync(f, 'utf8');
    if (sha256Hex(text) !== m.sha256) {
      this.logger.warn('filters.integrity-failed', { list: src.id });
      return null; // tampered or damaged -> ignored
    }
    return text;
  }

  private rebuild(): void {
    const baseline = fs.existsSync(this.baselineFile) ? fs.readFileSync(this.baselineFile, 'utf8') : '';
    const collect = (cat: 'ads' | 'trackers') =>
      FILTER_LISTS.filter((l) => (cat === 'ads' ? l.category === 'ads' : l.category === 'trackers'))
        .map((l) => this.readVerified(l))
        .filter((t): t is string => !!t);
    const adsText = collect('ads');
    const trkText = collect('trackers');
    const opts = { loadCosmeticFilters: false, loadNetworkFilters: true, enableCompression: false } as const;
    try {
      this.ads = FiltersEngine.parse(adsText.join('\n') || baseline, opts);
      this.trackers = FiltersEngine.parse(trkText.join('\n') || baseline, opts);
      this.logger.info('filters.loaded', { ads: adsText.length, trackers: trkText.length, baseline: !adsText.length || !trkText.length });
    } catch (err) {
      this.logger.error('filters.parse-failed', err);
    }
  }

  /** Download all lists from official sources. Keeps the previous copy on any failure. */
  async update(fetcher: ListFetcher): Promise<{ updated: string[]; failed: string[] }> {
    const updated: string[] = [];
    const failed: string[] = [];
    for (const src of FILTER_LISTS) {
      try {
        if (!src.url.startsWith('https://')) throw new Error('non-https source');
        const res = await fetcher(src.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (text.length > src.maxBytes) throw new Error('list too large');
        if (!looksLikeFilterList(text)) throw new Error('not a filter list');
        atomicWriteFile(this.listFile(src.id), text);
        this.meta.lists[src.id] = { sha256: sha256Hex(text), bytes: text.length, fetchedAt: new Date().toISOString() };
        updated.push(src.id);
      } catch (err) {
        failed.push(src.id);
        this.logger.warn('filters.update-failed', { list: src.id, message: (err as Error).message });
      }
    }
    if (updated.length) {
      this.meta.updatedAt = new Date().toISOString();
      atomicWriteFile(this.metaFile(), JSON.stringify(this.meta, null, 2));
      this.rebuild();
    }
    return { updated, failed };
  }

  /** Match one request. Top-level documents are never blocked (the user asked for them). */
  match(details: Electron.OnBeforeRequestListenerDetails, want: { ads: boolean; trackers: boolean }): MatchResult {
    if (details.resourceType === 'mainFrame') return { category: null };
    let req;
    try {
      req = Request.fromRawDetails({
        requestId: `${details.id}`,
        url: details.url,
        sourceUrl: details.referrer || undefined,
        type: (details.resourceType || 'other') as never,
        tabId: details.webContentsId,
      });
    } catch {
      return { category: null };
    }
    if (want.trackers && this.trackers) {
      const r = this.trackers.match(req);
      if (r.match) return { category: 'trackers', redirect: r.redirect?.dataUrl };
    }
    if (want.ads && this.ads) {
      const r = this.ads.match(req);
      if (r.match) return { category: 'ads', redirect: r.redirect?.dataUrl };
    }
    return { category: null };
  }
}
