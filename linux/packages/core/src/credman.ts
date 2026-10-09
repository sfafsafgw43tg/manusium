/**
 * packages/core/src/credman.ts
 *
 * Optional secret backend: Windows Credential Manager (generic credentials).
 *
 * WHY: DPAPI (used by the local keyring) already protects data at rest for the
 * current Windows account. Credential Manager is offered as an *alternative*
 * place to keep small secrets (e.g. proxy credentials) so that they live in the
 * OS vault instead of in our own file. It is OFF by default; the user chooses it
 * in Settings > Security and can switch back at any time.
 *
 * HOW: no native module, no third-party dependency. A short PowerShell script is
 * generated that P/Invokes CredWriteW / CredReadW / CredDeleteW / CredFree from
 * advapi32.dll (the same APIs Credential Manager itself uses). Communication is
 * JSON on stdin/stdout, so the secret never appears in a command line (process
 * monitors would show it) and never in a log.
 *
 * LIMITS (documented for the user):
 *  - generic credentials are limited to 2560 bytes of password data - plenty for
 *    a proxy login, useless for profile data (which stays in the local vault);
 *  - CredWrite is per-user: the credential is only readable by the same Windows
 *    user on the same machine, exactly like DPAPI;
 *  - credentials are NOT included in our backups - the local store is.
 */
import { spawnSync } from 'node:child_process';

/** A single command passed to the PowerShell helper. */
export type CredOp = 'write' | 'read' | 'delete';

export interface CredRequest {
  op: CredOp;
  /** Credential name, e.g. "OctoSuite/Octo.su/proxy:p-1a2b3c". */
  name: string;
  /** base64 of the secret (write only). */
  secretB64?: string;
  /** Optional comment shown in Credential Manager (never contains the secret). */
  comment?: string;
}

export interface CredResponse {
  ok: boolean;
  /** base64 of the secret (read only). */
  secretB64?: string;
  exists?: boolean;
  error?: string;
}

/** Function that runs the helper script. Injectable for unit tests. */
export type CredRunner = (script: string, input: string) => string;

/** Default runner: powershell.exe -NoProfile -Command -  (script on stdin). */
export const defaultCredRunner: CredRunner = (script, input) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
    input: `${script}\n${input}`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  if (r.error) throw new Error(`Credential Manager helper failed: ${r.error.message}`);
  if (r.status !== 0) {
    const err = (r.stderr || '').trim().split('\n').pop() || `exit code ${r.status}`;
    throw new Error(`Credential Manager helper failed: ${err}`);
  }
  return r.stdout ?? '';
};

/**
 * PowerShell helper. Kept as a template string so it can be unit-tested for the
 * API surface it uses (CredWriteW/CredReadW/CredDeleteW) without Windows.
 * The script is deliberately strict: it reads ONE JSON request from stdin and
 * writes ONE JSON response to stdout.
 */
export const CREDMAN_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OctoCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIALW {
    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIALW cred, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr cred);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool CredDeleteW(string target, uint type, uint flags);
  public const uint CRED_TYPE_GENERIC = 1u;
  public const uint CRED_PERSIST_LOCAL_MACHINE = 2u;
}
'@
} catch {
  # Type already defined in this PowerShell session - fine.
}
$in = [Console]::In.ReadToEnd()
$req = $in | ConvertFrom-Json
$name = [string]$req.name
$res = New-Object PSObject
Add-Member -InputObject $res -MemberType NoteProperty -Name ok -Value $false
if ($req.op -eq 'write') {
  $bytes = [Convert]::FromBase64String([string]$req.secretB64)
  $c = New-Object OctoCred+CREDENTIALW
  $c.Type = [OctoCred]::CRED_TYPE_GENERIC
  $c.Persist = [OctoCred]::CRED_PERSIST_LOCAL_MACHINE
  $c.TargetName = $name
  $c.UserName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  if ($req.comment) { $c.Comment = [string]$req.comment }
  $c.CredentialBlobSize = [uint32]$bytes.Length
  $c.CredentialBlob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $c.CredentialBlob, $bytes.Length)
  $ok = [OctoCred]::CredWriteW([ref]$c, 0)
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($c.CredentialBlob)
  Add-Member -InputObject $res -MemberType NoteProperty -Name ok -Value $ok -Force
} elseif ($req.op -eq 'read') {
  $ptr = [IntPtr]::Zero
  $ok = [OctoCred]::CredReadW($name, [OctoCred]::CRED_TYPE_GENERIC, 0, [ref]$ptr)
  if ($ok) {
    $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][OctoCred+CREDENTIALW])
    if ($c.CredentialBlobSize -gt 0) {
      $bytes = New-Object byte[] $c.CredentialBlobSize
      [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
      Add-Member -InputObject $res -MemberType NoteProperty -Name secretB64 -Value ([Convert]::ToBase64String($bytes)) -Force
    }
    [OctoCred]::CredFree($ptr)
  }
  # "not found" is a normal answer, not an error: ok stays true, exists tells.
  Add-Member -InputObject $res -MemberType NoteProperty -Name ok -Value $true -Force
  Add-Member -InputObject $res -MemberType NoteProperty -Name exists -Value $ok -Force
} elseif ($req.op -eq 'delete') {
  $ok = [OctoCred]::CredDeleteW($name, [OctoCred]::CRED_TYPE_GENERIC, 0)
  Add-Member -InputObject $res -MemberType NoteProperty -Name ok -Value $true -Force
  Add-Member -InputObject $res -MemberType NoteProperty -Name exists -Value $false -Force
} else {
  Add-Member -InputObject $res -MemberType NoteProperty -Name error -Value 'unknown op' -Force
}
$res | ConvertTo-Json -Compress
`.trim();

/** Max size of a generic credential blob (Windows limit is 2560 bytes). */
export const CREDMAN_MAX_BYTES = 2560;

export interface CredManOptions {
  /** Prefix of every credential name, e.g. "OctoSuite/Octo.su". */
  prefix: string;
  runner?: CredRunner;
  /** Overridden in tests / non-Windows builds. */
  available?: () => boolean;
}

/**
 * Small key/value interface over Windows Credential Manager.
 * Every method is safe to call when the vault is unavailable: they throw a
 * descriptive Error, which the caller turns into a user-visible message.
 */
export class CredManStore {
  private readonly runner: CredRunner;
  private readonly availableFn: () => boolean;

  constructor(private readonly opts: CredManOptions) {
    this.runner = opts.runner ?? defaultCredRunner;
    this.availableFn = opts.available ?? (() => process.platform === 'win32');
  }

  /** Display name for the UI. */
  get name(): string {
    return 'Windows Credential Manager';
  }

  available(): boolean {
    return this.availableFn();
  }

  /** Full credential name for a logical id (ids are already namespaced by the caller). */
  fullName(id: string): string {
    return `${this.opts.prefix}/${id}`;
  }

  private run(req: CredRequest): CredResponse {
    if (!this.available()) throw new Error(`${this.name} is not available on this system`);
    const out = this.runner(CREDMAN_SCRIPT, JSON.stringify(req));
    // The helper prints exactly one JSON object; ignore anything else on stdout.
    const line = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
    if (!line) throw new Error(`${this.name} returned no result`);
    const res = JSON.parse(line) as CredResponse;
    if (!res.ok) throw new Error(res.error || `${this.name} operation failed`);
    return res;
  }

  write(id: string, secret: string, comment?: string): void {
    const bytes = Buffer.from(secret, 'utf8');
    if (bytes.length > CREDMAN_MAX_BYTES) {
      throw new Error(`Secret too large for ${this.name} (${bytes.length} > ${CREDMAN_MAX_BYTES} bytes)`);
    }
    this.run({ op: 'write', name: this.fullName(id), secretB64: bytes.toString('base64'), comment });
  }

  /**
   * Read a secret. Returns null when the credential simply does not exist
   * (CredReadW returning FALSE is a normal answer, not an error); throws only
   * when the vault itself cannot be reached.
   */
  read(id: string): string | null {
    const res = this.run({ op: 'read', name: this.fullName(id) });
    if (res.exists === false || !res.secretB64) return null;
    return Buffer.from(res.secretB64, 'base64').toString('utf8');
  }

  has(id: string): boolean {
    return this.read(id) !== null;
  }

  delete(id: string): void {
    this.run({ op: 'delete', name: this.fullName(id) });
  }
}

/** Credential name prefix used by both applications. */
export function credPrefixFor(productName: string): string {
  return `OctoSuite/${productName}`;
}
