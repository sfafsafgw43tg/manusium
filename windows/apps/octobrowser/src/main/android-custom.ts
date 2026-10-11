/**
 * apps/octobrowser/src/main/android-custom.ts
 *
 * Android versions the catalogue does not carry.
 *
 * The built-in list covers the images most people want, but it can never
 * cover everything: a preview release, a TV or Wear image, an ABI the
 * catalogue skips, or a package that appeared after this build. Rather than
 * wait for us, a user can name the SDK package themselves - it is validated,
 * remembered and then offered in the creator like any other image.
 *
 * Nothing here downloads anything: the package is installed by the same
 * sdkmanager path as every other image.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export interface CustomImage {
  /** Stable id used by the creator. */
  id: string;
  /** What the user calls it. */
  label: string;
  /** The exact SDK package, e.g. system-images;android-35;google_apis;x86_64. */
  packageName: string;
  api: number;
  /** Publication month, as the user knows it (YYYY-MM), or ''. */
  released: string;
  addedAt: string;
}

export interface CustomCatalogue { images: CustomImage[] }

export interface LocalSystemImageInspection {
  source: string;
  api: number;
  abi: string;
  label: string;
  bytes: number;
  files: number;
}

export interface ImportedSystemImage {
  image: CustomImage;
  source: string;
  destination: string;
  bytes: number;
  files: number;
  abi: string;
}

const MAX_IMAGES = 40;
const PACKAGE = /^system-images;android-(\d{2,3}[A-Za-z-]*);([A-Za-z0-9_-]+);([A-Za-z0-9_-]+)$/;
const RELEASED = /^\d{4}-(0[1-9]|1[0-2])$/;

function file(): string {
  return path.join(os.homedir(), '.octobrowser', 'android-custom.json');
}

/** Where the file lives, so the UI can tell the user (and they can edit it). */
export function customCataloguePath(): string {
  return file();
}

export function readCustomCatalogue(): CustomCatalogue {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^\uFEFF/, '')) as { images?: unknown };
    const images = Array.isArray(raw.images) ? raw.images : [];
    return {
      images: images
        .map((entry) => entry as Partial<CustomImage>)
        .filter((entry): entry is CustomImage => typeof entry?.packageName === 'string' && PACKAGE.test(entry.packageName))
        .map((entry) => ({
          id: String(entry.id || entry.packageName),
          label: String(entry.label || entry.packageName).slice(0, 80),
          packageName: entry.packageName,
          api: Number(entry.api) || apiOf(entry.packageName),
          released: RELEASED.test(String(entry.released ?? '')) ? String(entry.released) : '',
          addedAt: String(entry.addedAt ?? ''),
        }))
        .slice(0, MAX_IMAGES),
    };
  } catch { return { images: [] }; }
}

/** API level out of a package name, e.g. 35 from `...;android-35;...`. */
export function apiOf(packageName: string): number {
  const match = PACKAGE.exec(String(packageName ?? ''));
  return match ? Number.parseInt(match[1], 10) || 0 : 0;
}

/**
 * Add one image. The package must look exactly like an SDK package, because
 * that string is handed to sdkmanager and to avdmanager verbatim.
 */
export function addCustomImage(input: { label?: string; packageName?: string; released?: string }): CustomImage {
  const packageName = String(input?.packageName ?? '').trim();
  if (!PACKAGE.test(packageName)) {
    throw new Error('A system image looks like "system-images;android-35;google_apis;x86_64" - copy it from sdkmanager --list.');
  }
  const released = String(input?.released ?? '').trim();
  if (released && !RELEASED.test(released)) throw new Error('Write the release month as YYYY-MM, for example 2024-10.');
  const parts = packageName.split(';');
  const entry: CustomImage = {
    id: packageName,
    label: String(input?.label ?? '').trim().slice(0, 80) || `Android ${apiOf(packageName)} · ${parts[2]} · ${parts[3]}`,
    packageName,
    api: apiOf(packageName),
    released,
    addedAt: new Date().toISOString(),
  };
  const current = readCustomCatalogue();
  const next = [entry, ...current.images.filter((item) => item.packageName !== packageName)].slice(0, MAX_IMAGES);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ images: next }, null, 2) + '\n', { mode: 0o600 });
  return entry;
}

export function removeCustomImage(packageName: string): boolean {
  const current = readCustomCatalogue();
  const next = current.images.filter((item) => item.packageName !== String(packageName ?? ''));
  if (next.length === current.images.length) return false;
  try {
    fs.writeFileSync(file(), JSON.stringify({ images: next }, null, 2) + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** Is this a package we are willing to hand to the SDK tools? */
export function validCustomPackage(packageName: string): boolean {
  return PACKAGE.test(String(packageName ?? ''));
}

const IMAGE_LIMIT_BYTES = 25 * 1024 * 1024 * 1024;
const IMAGE_LIMIT_FILES = 512;
const IMAGE_ABIS = new Set(['x86', 'x86_64', 'arm64-v8a']);

function properties(filePath: string): Record<string, string> {
  try {
    return Object.fromEntries(fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((line) => {
      const at = line.indexOf('=');
      return at > 0 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : ['', ''];
    }).filter(([key]) => key));
  } catch { return {}; }
}

function completeImageDirectory(dir: string): boolean {
  try {
    const names = new Set(fs.readdirSync(dir).map((name) => name.toLowerCase()));
    const kernel = [...names].some((name) => name.startsWith('kernel-ranchu') || name.startsWith('kernel-qemu'));
    return names.has('system.img') && names.has('ramdisk.img') && names.has('userdata.img') && kernel;
  } catch { return false; }
}

/** Find the image root inside an extracted emu_img_zip without scanning an arbitrary tree. */
function findImageDirectory(selected: string): string {
  const root = path.resolve(selected);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('Choose an extracted Android emulator system-image folder.');
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const item = queue.shift()!;
    if (++visited > 200) break;
    if (completeImageDirectory(item.dir)) return item.dir;
    if (item.depth >= 3) continue;
    for (const entry of fs.readdirSync(item.dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name.startsWith('.')) continue;
      queue.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 });
    }
  }
  throw new Error('No complete emulator image was found. The folder must contain system.img, ramdisk.img, userdata.img and kernel-ranchu or kernel-qemu. Phone firmware ZIPs and a lone GSI system.img are not complete emulator images.');
}

function imageMetadata(dir: string): { api: number; abi: string; label: string } {
  const props = properties(path.join(dir, 'source.properties'));
  let xml = '';
  try { xml = fs.readFileSync(path.join(dir, 'package.xml'), 'utf8'); } catch { /* optional */ }
  const api = Number.parseInt(props['AndroidVersion.ApiLevel'] || xml.match(/<api-level>(\d+)<\/api-level>/)?.[1]
    || dir.match(/android-(\d{2,3})/i)?.[1] || '', 10);
  const abi = String(props['SystemImage.Abi'] || xml.match(/<abi>([^<]+)<\/abi>/)?.[1]
    || [...dir.split(/[\\/]/)].reverse().find((part) => IMAGE_ABIS.has(part)) || '').trim();
  if (!Number.isInteger(api) || api < 21 || api > 999) throw new Error('The image does not declare an Android API level. Keep source.properties/package.xml from the AOSP emulator-image package, or put it under an android-<API> folder.');
  if (!IMAGE_ABIS.has(abi)) throw new Error(`The image ABI “${abi || 'unknown'}” is not supported. Use an x86, x86_64 or arm64-v8a emulator image.`);
  const label = String(props['Pkg.Desc'] || `Imported Android ${api} · ${abi}`).replace(/[\r\n=]+/g, ' ').trim();
  return { api, abi, label: label.slice(0, 80) };
}

function imageFiles(root: string): Array<{ source: string; relative: string; bytes: number }> {
  const files: Array<{ source: string; relative: string; bytes: number }> = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (!relative || relative.startsWith('..')) continue;
      if (entry.isSymbolicLink()) throw new Error('System-image folders containing symbolic links are not imported. Extract the archive normally and try again.');
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name !== 'package.xml') {
        const bytes = fs.statSync(full).size;
        files.push({ source: full, relative, bytes });
        if (files.length > IMAGE_LIMIT_FILES || files.reduce((sum, file) => sum + file.bytes, 0) > IMAGE_LIMIT_BYTES) {
          throw new Error('The selected image is too large (limit: 512 files and 25 GB).');
        }
      }
    }
  };
  visit(root);
  return files;
}

export function inspectSystemImageDirectory(selected: string): LocalSystemImageInspection {
  const source = findImageDirectory(selected);
  const meta = imageMetadata(source);
  const files = imageFiles(source);
  return {
    source, ...meta, files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/**
 * Import an extracted AOSP/Android Emulator image into the writable SDK used by
 * Octo. This deliberately rejects OEM recovery/OTA ROMs and lone GSI files:
 * those target physical-device boot/vendor partitions and cannot safely boot
 * as an Android Studio AVD without a matching emulator kernel and ramdisk.
 */
export async function importSystemImageDirectory(
  selected: string,
  sdkRoot: string,
  onProgress?: (copied: number, total: number, file: string) => void,
  identityPath = selected,
): Promise<ImportedSystemImage> {
  const inspected = inspectSystemImageDirectory(selected);
  const source = inspected.source;
  const meta = { api: inspected.api, abi: inspected.abi, label: inspected.label };
  const files = imageFiles(source);
  const bytes = inspected.bytes;
  const slug = path.basename(identityPath, path.extname(identityPath)).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'image';
  const digest = crypto.createHash('sha256').update(path.resolve(identityPath)).digest('hex').slice(0, 8);
  const tag = `octo_local_${slug}_${digest}`;
  const packageName = `system-images;android-${meta.api};${tag};${meta.abi}`;
  const destination = path.join(path.resolve(sdkRoot), ...packageName.split(';'));
  const temp = `${destination}.importing-${process.pid}`;
  const sourceResolved = path.resolve(source);
  if (destination === sourceResolved || destination.startsWith(`${sourceResolved}${path.sep}`) || sourceResolved.startsWith(`${destination}${path.sep}`)) {
    throw new Error('Choose a source folder outside the Android SDK destination.');
  }
  if (fs.existsSync(destination)) throw new Error(`This directory is already imported as ${packageName}.`);
  fs.mkdirSync(sdkRoot, { recursive: true });
  try {
    const disk = fs.statfsSync(fs.existsSync(path.dirname(destination)) ? path.dirname(destination) : sdkRoot);
    const free = Number(disk.bavail) * Number(disk.bsize);
    if (free > 0 && free < bytes + 512 * 1024 * 1024) throw new Error('There is not enough free space to import and unpack this system image.');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('There is not enough')) throw error;
  }
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  let copied = 0;
  try {
    for (const file of files) {
      const target = path.join(temp, file.relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(file.source, target, fs.constants.COPYFILE_EXCL);
      copied += file.bytes;
      onProgress?.(copied, bytes, file.relative);
    }
    fs.writeFileSync(path.join(temp, 'source.properties'), [
      `Pkg.Desc=${meta.label}`,
      'Pkg.Revision=1',
      `AndroidVersion.ApiLevel=${meta.api}`,
      `SystemImage.Abi=${meta.abi}`,
      `SystemImage.TagId=${tag}`,
      `SystemImage.TagDisplay=Octo local image`,
      '',
    ].join('\n'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(temp, destination);
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  let image: CustomImage;
  try { image = addCustomImage({ label: meta.label, packageName }); }
  catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { image, source, destination, bytes, files: files.length, abi: meta.abi };
}

type ArchiveFile = { name: string; bytes: number };

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('The selected file is not a readable ZIP archive.'));
      else resolve(zip);
    });
  });
}

function safeArchiveName(entry: Entry): string | null {
  const name = entry.fileName.replace(/\\/g, '/');
  if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`The ROM archive contains an unsafe path: ${name.slice(0, 120)}`);
  }
  const parts = name.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..') || parts.length > 8) {
    throw new Error(`The ROM archive contains an unsafe path: ${name.slice(0, 120)}`);
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new Error('Encrypted ROM archives are not supported.');
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if ((mode & 0o170000) === 0o120000) throw new Error('ROM archives containing symbolic links are not imported.');
  return name.endsWith('/') ? null : parts.join('/');
}

async function archiveFiles(filePath: string): Promise<ArchiveFile[]> {
  const zip = await openZip(filePath);
  return new Promise((resolve, reject) => {
    const files: ArchiveFile[] = [];
    let bytes = 0;
    zip.on('error', reject);
    zip.on('entry', (entry: Entry) => {
      try {
        const name = safeArchiveName(entry);
        if (name) {
          bytes += entry.uncompressedSize;
          files.push({ name, bytes: entry.uncompressedSize });
          if (files.length > IMAGE_LIMIT_FILES || bytes > IMAGE_LIMIT_BYTES) {
            throw new Error('The selected ROM archive is too large (limit: 512 files and 25 GB unpacked).');
          }
        }
        zip.readEntry();
      } catch (error) { zip.close(); reject(error); }
    });
    zip.on('end', () => resolve(files));
    zip.readEntry();
  });
}

function entryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`Could not unpack ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

async function extractArchive(
  filePath: string,
  destination: string,
  expected: ArchiveFile[],
  onProgress?: (copied: number, total: number, file: string) => void,
): Promise<void> {
  const zip = await openZip(filePath);
  const sizes = new Map(expected.map((file) => [file.name, file.bytes]));
  const total = expected.reduce((sum, file) => sum + file.bytes, 0);
  let copied = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on('error', fail);
    zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        const name = safeArchiveName(entry);
        if (!name) { zip.readEntry(); return; }
        if (sizes.get(name) !== entry.uncompressedSize) throw new Error('The ROM archive changed while it was being read.');
        const target = path.resolve(destination, ...name.split('/'));
        if (!target.startsWith(`${path.resolve(destination)}${path.sep}`)) throw new Error(`Unsafe ROM archive path: ${name}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const stream = await entryStream(zip, entry);
        stream.on('data', (chunk: Buffer) => {
          copied += chunk.length;
          onProgress?.(copied, total, name);
        });
        await pipeline(stream, fs.createWriteStream(target, { flags: 'wx' }));
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

/**
 * Unpack and import a selected emulator-ROM ZIP, then return the registered SDK
 * image used by the normal AVD creation path. Physical-device firmware still
 * fails complete-image validation rather than producing an unbootable VM.
 */
export async function importSystemImageArchive(
  selected: string,
  sdkRoot: string,
  onProgress?: (stage: 'unzip' | 'import', copied: number, total: number, file: string) => void,
  acceptAbi?: (abi: string) => boolean,
): Promise<ImportedSystemImage> {
  const archive = path.resolve(selected);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(archive); } catch { throw new Error('Choose a local Android emulator ROM ZIP.'); }
  if (!stat.isFile() || stat.isSymbolicLink() || path.extname(archive).toLowerCase() !== '.zip') {
    throw new Error('Choose a regular .zip file containing an Android Emulator/AOSP system image.');
  }
  if (stat.size > IMAGE_LIMIT_BYTES) throw new Error('The selected ROM ZIP is larger than 25 GB.');
  const files = await archiveFiles(archive);
  if (!files.length) throw new Error('The selected ROM ZIP is empty.');
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const root = path.resolve(sdkRoot);
  fs.mkdirSync(root, { recursive: true });
  try {
    const disk = fs.statfsSync(root);
    const free = Number(disk.bavail) * Number(disk.bsize);
    if (free > 0 && free < bytes * 2 + 512 * 1024 * 1024) {
      throw new Error('There is not enough free space to unpack and import this ROM image.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('There is not enough')) throw error;
  }
  const temp = path.join(root, `.octo-rom-import-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(temp, { recursive: true });
  try {
    await extractArchive(archive, temp, files, (copied, total, file) => onProgress?.('unzip', copied, total, file));
    const inspected = inspectSystemImageDirectory(temp);
    if (acceptAbi && !acceptAbi(inspected.abi)) {
      throw new Error(`This ${inspected.abi} ROM cannot run on this ${process.arch} computer. Choose an emulator image built for the host architecture.`);
    }
    const result = await importSystemImageDirectory(inspected.source, root,
      (copied, total, file) => onProgress?.('import', copied, total, file), archive);
    return { ...result, source: archive };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
