import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] || (process.platform === 'win32' ? 'win32-x64' : 'linux-x64');
const out = path.join(root, '.runtime-test');
const versionDir = path.join(out, '155.0.8059.39');
try {
  if (target === 'win32-x64') {
    const packaged = path.join(root, 'resources', 'engines', 'chromium', '155.0.8059.39');
    const manifestPath = path.join(packaged, 'runtime.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`source-built Windows runtime is missing: ${manifestPath}; run npm run build:chromium:windows on Windows first`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.distribution !== 'source-built' || manifest.modified !== true) throw new Error('refusing to test a repackaged Chrome for Testing runtime');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    fs.cpSync(packaged, versionDir, { recursive: true });
  } else {
    const stage = spawnSync(process.execPath, [path.join(root, 'tools', 'stage-chromium.mjs'), '--target', target, '--out', versionDir], { cwd: root, stdio: 'inherit' });
    if (stage.status !== 0) process.exit(stage.status ?? 1);
  }
  const runner = process.platform === 'win32' ? process.env.ComSpec : process.execPath;
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npx vitest run packages/shell/test/native-engine.integration.test.ts'] : [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'packages/shell/test/native-engine.integration.test.ts'];
  const result = spawnSync(runner, args, { cwd: root, env: { ...process.env, OCTO_PACKAGED_CHROMIUM_ROOT: out }, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
