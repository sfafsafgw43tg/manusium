import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/** Version of the app-to-engine contract, independent of the engine version. */
export const ENGINE_RUNNER_CONTRACT_VERSION = 1 as const;
export const ENGINE_MANIFEST_SCHEMA = 'octo.engine-manifest.v1' as const;

export type EngineKind = 'chromium' | 'gecko';
export type EngineProtocol = 'cdp' | 'juggler';
export type EngineCapability =
  | 'window'
  | 'tabs'
  | 'navigation'
  | 'permissions'
  | 'downloads'
  | 'storage'
  | 'crash-recovery';

export interface EngineManifest {
  schema: typeof ENGINE_MANIFEST_SCHEMA;
  kind: EngineKind;
  version: string;
  executable: string;
  protocol: EngineProtocol;
  platforms: Array<'win32-x64' | 'win32-arm64' | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64'>;
  capabilities: EngineCapability[];
  sha256?: string;
  /** Windows Chromium must identify itself as a source build, never CfT. */
  distribution?: 'source-built' | 'catalog-archive';
  modified?: boolean;
  source?: { url: string; archiveSha256: string; license: string };
}

export interface DiscoveredEngineRuntime {
  kind: EngineKind;
  version: string;
  rootDir: string;
  executablePath: string;
  manifestPath: string;
  manifest: EngineManifest;
}

export type EngineRunnerErrorCode =
  | 'runtime-missing'
  | 'manifest-invalid'
  | 'executable-missing'
  | 'unsupported-platform'
  | 'protocol-unavailable'
  | 'profile-invalid'
  | 'launch-failed'
  | 'navigation-failed'
  | 'crashed';

export class EngineRunnerError extends Error {
  constructor(readonly code: EngineRunnerErrorCode, message: string) {
    super(message);
    this.name = 'EngineRunnerError';
  }
}

export interface EngineTabState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  crashed: boolean;
}

export interface EngineLaunchOptions {
  profileDir: string;
  initialUrl: string;
  visible: boolean;
  debugPort?: number;
}

/**
 * Shared contract for both native adapters. Implementations may expose a
 * smaller capability set only when the manifest says that capability is not
 * available; they must reject unsupported calls with EngineRunnerError.
 */
export interface EngineSession {
  readonly contractVersion: typeof ENGINE_RUNNER_CONTRACT_VERSION;
  readonly runtime: DiscoveredEngineRuntime;
  readonly profileDir: string;
  tabs(): Promise<EngineTabState[]>;
  newTab(url: string, activate?: boolean): Promise<EngineTabState>;
  activateTab(id: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  navigate(tabId: string, url: string): Promise<void>;
  activeState(): Promise<EngineTabState>;
  grantPermission(origin: string, permission: string, allow: boolean): Promise<void>;
  setDownloadDirectory(directory: string): Promise<void>;
  readStorage(tabId: string): Promise<Record<string, string>>;
  recover(): Promise<void>;
  close(): Promise<void>;
}

export interface EngineRunner {
  readonly contractVersion: typeof ENGINE_RUNNER_CONTRACT_VERSION;
  readonly runtime: DiscoveredEngineRuntime;
  launch(options: EngineLaunchOptions): Promise<EngineSession>;
}

export interface RuntimeDiscoveryOptions {
  resourcesPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  version?: string;
}

function targetPlatform(platform: NodeJS.Platform, arch: string): EngineManifest['platforms'][number] | null {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  if (platform === 'win32' && arch === 'arm64') return 'win32-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  return null;
}

function executableName(kind: EngineKind, platform: NodeJS.Platform): string {
  if (kind === 'chromium') return platform === 'win32' ? 'inkbrowser-chrome.exe' : 'inkbrowser-chrome';
  return platform === 'win32' ? 'inkbrowser-firefox.exe' : 'inkbrowser-firefox';
}

function readManifest(file: string): EngineManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new EngineRunnerError('manifest-invalid', `Could not read engine manifest ${file}: ${String(error)}`);
  }
  const m = parsed as Partial<EngineManifest>;
  if (m.schema !== ENGINE_MANIFEST_SCHEMA || (m.kind !== 'chromium' && m.kind !== 'gecko') || typeof m.version !== 'string' || !m.version || typeof m.executable !== 'string' || !m.executable || (m.protocol !== 'cdp' && m.protocol !== 'juggler') || !Array.isArray(m.platforms) || !Array.isArray(m.capabilities)) {
    throw new EngineRunnerError('manifest-invalid', `Invalid engine manifest: ${file}`);
  }
  return m as EngineManifest;
}

function fileSha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Discover only signed/packaged-layout candidates. The caller may use an
 * explicit environment override for development, but the manifest remains
 * mandatory and the executable must stay inside that runtime directory.
 */
export function discoverEngineRuntime(kind: EngineKind, options: RuntimeDiscoveryOptions = {}): DiscoveredEngineRuntime {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = targetPlatform(platform, arch);
  if (!target) throw new EngineRunnerError('unsupported-platform', `Unsupported engine platform ${platform}-${arch}`);
  const rootOverride = options.env?.[kind === 'chromium' ? 'OCTO_CHROMIUM_RUNTIME' : 'OCTO_GECKO_RUNTIME'];
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const roots = [
    rootOverride,
    resourcesPath ? path.join(resourcesPath, 'engines', kind) : undefined,
    path.join(process.cwd(), 'engines', kind),
  ].filter((value): value is string => Boolean(value));
  let lastMissing = '';
  for (const root of roots) {
    if (!fs.existsSync(root)) { lastMissing = root; continue; }
    const versions = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const version of versions) {
      if (options.version && version !== options.version) continue;
      const runtimeRoot = path.join(root, version);
      const manifestPath = path.join(runtimeRoot, 'runtime.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = readManifest(manifestPath);
      if (manifest.kind !== kind) throw new EngineRunnerError('manifest-invalid', `Manifest kind does not match ${kind}: ${manifestPath}`);
      if (kind === 'chromium' && platform === 'win32' && (manifest.distribution !== 'source-built' || manifest.modified !== true)) {
        throw new EngineRunnerError('manifest-invalid', `Windows Chromium runtime is not source-built: ${manifestPath}`);
      }
      if (!manifest.platforms.includes(target)) throw new EngineRunnerError('unsupported-platform', `${manifest.kind} ${manifest.version} does not support ${target}`);
      const executablePath = path.resolve(runtimeRoot, manifest.executable);
      if (!executablePath.startsWith(`${path.resolve(runtimeRoot)}${path.sep}`) || !fs.existsSync(executablePath)) {
        throw new EngineRunnerError('executable-missing', `Engine executable is missing or escapes its runtime directory: ${executablePath}`);
      }
      if (path.basename(executablePath) !== executableName(kind, platform)) {
        throw new EngineRunnerError('manifest-invalid', `Unexpected ${kind} executable name: ${path.basename(executablePath)}`);
      }
      if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) throw new EngineRunnerError('manifest-invalid', `Missing or invalid executable SHA-256 in ${manifestPath}`);
      if (fileSha256(executablePath).toLowerCase() !== manifest.sha256.toLowerCase()) throw new EngineRunnerError('manifest-invalid', `Executable checksum mismatch: ${executablePath}`);
      return { kind, version: manifest.version, rootDir: runtimeRoot, executablePath, manifestPath, manifest };
    }
  }
  throw new EngineRunnerError('runtime-missing', `No packaged ${kind} runtime found${lastMissing ? ` under ${lastMissing}` : ''}`);
}
