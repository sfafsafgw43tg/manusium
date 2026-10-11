/**
 * packages/core/src/network.ts
 *
 * Pure helpers for the traffic panel and OctoDetect's connection report.
 * Heuristics are labelled as such in the UI - e.g. we can say "a VPN adapter
 * appears to be active", never "you are protected".
 */

export interface NetIf { name: string; address: string; family: string | number; internal: boolean }

const VPN_NAME_RE = /(wireguard|\bwg\d*\b|\btun\d*\b|\btap\b|tap-windows|openvpn|nordlynx|proton|mullvad|\bvpn\b|ppp|zerotier|tailscale|wintun|ivpn|expressvpn|surfshark|windscribe|fortinet|anyconnect|globalprotect)/i;

/** Detect interfaces that look like VPN tunnels (heuristic). */
export function detectVpnAdapters(ifaces: Record<string, Array<Omit<NetIf, 'name'>> | undefined>): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || addrs.every((a) => a.internal)) continue;
    if (VPN_NAME_RE.test(name)) out.push(name);
  }
  return out;
}

/** RFC1918 / link-local / CGNAT / ULA / loopback detection. */
export function isPrivateIp(ip: string): boolean {
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^127\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const c = /^100\.(\d+)\./.exec(ip);
  if (c && Number(c[1]) >= 64 && Number(c[1]) <= 127) return true;
  const low = ip.toLowerCase();
  return low === '::1' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd');
}

export function isIp(s: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s) || /^[0-9a-f:]+$/i.test(s) && s.includes(':');
}

/** Parse https://1.1.1.1/cdn-cgi/trace output (key=value lines). */
export function parseTrace(text: string): { ip?: string; loc?: string; warp?: string } {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { ip: out.ip && isIp(out.ip) ? out.ip : undefined, loc: out.loc, warp: out.warp };
}

/** Mask the last part of an IP for display/logging (full IP never logged). */
export function maskIp(ip: string): string {
  if (ip.includes('.')) return ip.replace(/\.\d+$/, '.xxx');
  const parts = ip.split(':');
  return parts.slice(0, 3).join(':') + ':…';
}

export type LeakStatus = 'ok' | 'warning' | 'leak' | 'unknown';

/**
 * DNS leak heuristic: when traffic is supposed to go through a proxy/Tor/VPN but
 * the system resolvers are private LAN/ISP addresses, name lookups may bypass the tunnel.
 * (SOCKS5 proxies resolve remotely in Chromium, HTTP proxies too - so only
 * VPN + LAN resolver is flagged; "unknown" when nothing to compare.)
 */
export function assessDns(opts: { dnsServers: string[]; vpnDetected: boolean; proxyActive: boolean; dohActive: boolean }): LeakStatus {
  if (opts.dohActive) return 'ok';
  if (opts.dnsServers.length === 0) return 'unknown';
  if (opts.proxyActive) return 'ok';
  if (opts.vpnDetected && opts.dnsServers.every((s) => isPrivateIp(s) && !s.startsWith('100.'))) return 'warning';
  return opts.vpnDetected ? 'ok' : 'unknown';
}

/**
 * WebRTC leak: any non-mDNS IP gathered by ICE that differs from the public IP
 * seen by HTTP while a proxy/VPN is active is a leak. Private IPs exposed are a warning.
 */
export function assessWebRtc(opts: { rtcIps: string[]; httpPublicIp?: string; tunnelActive: boolean; policy?: string }): LeakStatus {
  if (opts.policy === 'disable_non_proxied_udp' && opts.rtcIps.length === 0) return 'ok';
  const publics = opts.rtcIps.filter((ip) => !isPrivateIp(ip));
  const privates = opts.rtcIps.filter((ip) => isPrivateIp(ip));
  if (opts.tunnelActive && opts.httpPublicIp && publics.some((ip) => ip !== opts.httpPublicIp)) return 'leak';
  if (privates.length > 0) return 'warning';
  if (!opts.httpPublicIp && publics.length > 0) return 'unknown';
  return 'ok';
}

/** Human readable byte size. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
