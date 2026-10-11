/**
 * apps/octobrowser/src/main/extensions.ts
 *
 * Paths and metadata for reviewed WebExtensions bundled with OctoBrowser.
 * A profile process loads an enabled bundle into its own default session, so
 * extension storage and any granted active-tab access remain profile-local.
 */
import * as path from 'node:path';

export interface BundledExtension {
  /** Matching id from packages/core/src/addons.ts. */
  addonId: string;
  /** Folder shipped below resources/addons in packaged builds. */
  folder: string;
  /** Local extension page made available through the OctoBrowser Add-ons panel. */
  entryPage: string;
}

const BUNDLED_EXTENSIONS: readonly BundledExtension[] = Object.freeze([
  { addonId: 'proximal-editor', folder: 'proximal-editor', entryPage: 'workspace.html' },
]);

export function bundledExtension(addonId: string): BundledExtension | undefined {
  return BUNDLED_EXTENSIONS.find((extension) => extension.addonId === addonId);
}

/**
 * Locate the unpacked extension source in both developer and packaged builds.
 * Electron must load extensions from a real directory, never from app.asar.
 */
export function bundledExtensionPath(extension: BundledExtension, distDir: string, packaged: boolean, resourcesDir: string): string {
  return packaged
    ? path.join(resourcesDir, 'addons', extension.folder)
    : path.resolve(distDir, '..', '..', '..', 'resources', 'addons', extension.folder);
}
