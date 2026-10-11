/** Canonical profile session partition helpers. */
import { randomUUID } from 'node:crypto';

export function profilePartition(profileId: string): string {
  if (!/^[a-z0-9-]{3,64}$/.test(profileId)) throw new Error('invalid profile partition id');
  return `persist:octo-profile-${profileId}`;
}

/** A fresh non-persistent partition. Never pass this to defaultSession. */
export function ephemeralPartition(): string {
  return `octo-ephemeral-${randomUUID()}`;
}
