import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, 'resources', 'native-camera');

if (process.platform !== 'win32') {
  console.log('native camera: skipped (Windows-only Media Foundation target)');
  process.exit(0);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

// MSVC's FileTracker can fail before compilation when the checkout is on a
// mapped/network drive or contains a long duplicated folder name (for example
// `project (48)\project`). Keep the source checkout untouched, but compile
// from a short local temporary path and copy only the finished binaries back.
const tempParent = process.env.TEMP || process.env.TMP || (process.env.SystemDrive ? `${process.env.SystemDrive}\\Temp` : 'C:\\Temp');
fs.mkdirSync(tempParent, { recursive: true });
const staging = fs.mkdtempSync(path.join(tempParent, 'octo-cam-'));
const projects = [
  { source: path.join(root, 'native', 'octo-camera'), staged: path.join(staging, 'camera'), build: path.join(staging, 'camera-build') },
  { source: path.join(root, 'native', 'octo-directshow'), staged: path.join(staging, 'directshow'), build: path.join(staging, 'directshow-build') },
];

fs.mkdirSync(output, { recursive: true });
let completed = false;
try {
  for (const project of projects) {
    fs.cpSync(project.source, project.staged, { recursive: true, filter: (entry) => !entry.includes(`${path.sep}build${path.sep}`) && !entry.endsWith(`${path.sep}build`) });
    // DirectShow consumes the producer's shared-memory protocol header. Keep
    // the source trees independent in Git, but stage the shared header beside
    // the DirectShow CMake project before compiling from the short temp path.
    if (path.basename(project.source) === 'octo-directshow') {
      fs.copyFileSync(path.join(root, 'native', 'octo-camera', 'feed_protocol.h'), path.join(project.staged, 'feed_protocol.h'));
    }
    run('cmake', ['-S', project.staged, '-B', project.build, '-A', 'x64']);
    run('cmake', ['--build', project.build, '--config', 'Release', '--parallel']);
  }

  const artifacts = [
    ['octo-camera-source.dll', projects[0].build],
    ['octo-cameractl.exe', projects[0].build],
    ['octo-directshow-camera.dll', projects[1].build],
  ];
  for (const [name, build] of artifacts) {
    const candidates = [path.join(build, 'Release', name), path.join(build, name)];
    const source = candidates.find((file) => fs.existsSync(file));
    if (!source) throw new Error(`Native camera build did not produce ${name}`);
    fs.copyFileSync(source, path.join(output, name));
  }
  fs.writeFileSync(path.join(output, 'BUILD.txt'), `Built by CMake on ${new Date().toISOString()}\n`);
  completed = true;
  console.log(`native camera: staged to ${path.relative(root, output)}`);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)} (CMake staging path: ${staging})`);
} finally {
  // Keep failed staging directories for diagnostics; successful builds do not
  // leave multi-config CMake trees behind in the user's temp folder.
  if (completed) fs.rmSync(staging, { recursive: true, force: true });
}
