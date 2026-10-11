import { describe, expect, it, vi } from 'vitest';
import type { Session, WebContents } from 'electron';
import { defaultProfile } from '@octo/core';
import type { Logger } from '@octo/core';
import { ProfileSessionController } from '../src/session-privacy';
import type { PrivacyHooks } from '../src/session-privacy';

type PermissionHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function permissionFixture(askPermission: PrivacyHooks['askPermission'], clipboard: 'allow' | 'block' = 'allow') {
  let handler: PermissionHandler | undefined;
  const session = {
    setPermissionRequestHandler: (value: PermissionHandler) => { handler = value; },
    setPermissionCheckHandler: () => undefined,
    setDevicePermissionHandler: () => undefined,
    on: () => undefined,
  } as unknown as Session;
  const hooks = {
    logger: { info: vi.fn() } as unknown as Logger,
    adblock: null,
    askPermission,
    confirmDangerousDownload: async () => false,
  } as PrivacyHooks;
  const profile = defaultProfile('personal', 'Permission test');
  profile.sandbox.clipboard = clipboard;
  const controller = new ProfileSessionController(session, profile, '', hooks);
  (controller as unknown as { installPermissions: () => void }).installPermissions();
  if (!handler) throw new Error('Permission handler was not installed');
  const request = (requestingUrl: string, kind: 'camera' | 'microphone' | 'geolocation' | 'notifications' | 'clipboard-read' | 'clipboard-sanitized-write' | 'devices' | 'display-capture' = 'geolocation') => new Promise<boolean>((resolve) => {
    handler!({ getURL: () => requestingUrl } as unknown as WebContents, (kind === 'camera' || kind === 'microphone' ? 'media' : kind === 'devices' ? 'usb' : kind), resolve,
      { requestingUrl } as Parameters<PermissionHandler>[3]);
  });
  return { request };
}

describe('same-origin permission prompt deduplication', () => {
  it('shows one location prompt for concurrent requests and reuses the session decision', async () => {
    const answer = deferred<boolean>();
    const askPermission = vi.fn(() => answer.promise);
    const { request } = permissionFixture(askPermission);
    const url = 'https://pixelscan.net/location-check';

    const requests = Array.from({ length: 4 }, () => request(url));
    await vi.waitFor(() => expect(askPermission).toHaveBeenCalledTimes(1));
    expect(askPermission).toHaveBeenCalledWith(expect.anything(), 'geolocation', 'https://pixelscan.net');

    answer.resolve(true);
    await expect(Promise.all(requests)).resolves.toEqual([true, true, true, true]);
    await expect(request('https://pixelscan.net/another-check')).resolves.toBe(true);
    expect(askPermission).toHaveBeenCalledTimes(1);
  });

  it('shares a deny decision across concurrent requests without repeating the prompt', async () => {
    const answer = deferred<boolean>();
    const askPermission = vi.fn(() => answer.promise);
    const { request } = permissionFixture(askPermission);

    const requests = [request('https://pixelscan.net/'), request('https://pixelscan.net/other')];
    await vi.waitFor(() => expect(askPermission).toHaveBeenCalledTimes(1));
    answer.resolve(false);

    await expect(Promise.all(requests)).resolves.toEqual([false, false]);
    await expect(request('https://pixelscan.net/later')).resolves.toBe(false);
    expect(askPermission).toHaveBeenCalledTimes(1);
  });

  it('does not turn profile settings into grants for imported permission categories', async () => {
    const askPermission = vi.fn(async () => false);
    const kinds = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'devices', 'display-capture'] as const;
    for (const kind of kinds) {
      const { request } = permissionFixture(askPermission);
      await expect(request('https://example.test/', kind)).resolves.toBe(false);
    }
    expect(askPermission).toHaveBeenCalledTimes(6);
  });

  it('allows site Copy buttons without allowing pages to read the clipboard', async () => {
    const askPermission = vi.fn(async () => false);
    const allowed = permissionFixture(askPermission, 'allow');
    await expect(allowed.request('https://example.test/', 'clipboard-sanitized-write')).resolves.toBe(true);
    const blocked = permissionFixture(askPermission, 'block');
    await expect(blocked.request('https://example.test/', 'clipboard-sanitized-write')).resolves.toBe(false);
    expect(askPermission).not.toHaveBeenCalled();
  });

});
