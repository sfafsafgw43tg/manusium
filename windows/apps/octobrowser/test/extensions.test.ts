/** Bundled WebExtension metadata and source layout. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledExtension, bundledExtensionPath } from '../src/main/extensions';
import { ADDONS } from '@octo/core';

const root = process.cwd();
const distDir = path.join(root, 'apps', 'octobrowser', 'dist');

describe('bundled PrOximAl Editor extension', () => {
  it('is catalogued with a clear local-only description and non-default enablement', () => {
    const addon = ADDONS.find((item) => item.id === 'proximal-editor');
    expect(addon).toMatchObject({
      name: 'PrOximAl Editor', kind: 'extension', version: '1.0.0', defaultEnabled: false,
    });
    expect(addon?.description.en).toMatch(/local-only/i);
    expect(addon?.description.en).toMatch(/never submits forms/i);
  });

  it('ships the reviewed source and declares no host permissions or extension-page network access', () => {
    const extension = bundledExtension('proximal-editor');
    expect(extension).toBeDefined();
    const source = bundledExtensionPath(extension!, distDir, false, '/unused-resources-dir');
    expect(source).toBe(path.join(root, 'resources', 'addons', 'proximal-editor'));

    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8')) as {
      manifest_version: number; permissions: string[]; host_permissions?: string[]; content_security_policy?: { extension_pages?: string };
    };
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(expect.arrayContaining(['activeTab', 'contextMenus', 'scripting', 'storage']));
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.content_security_policy?.extension_pages).toContain("connect-src 'none'");
  });
});
