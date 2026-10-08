import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReleaseNatives } from './native-release-build.mjs';
import { nativeCargoPackages, packageEdition } from './package-editions.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = resolve(repositoryRoot, 'apps/desktop');
export const buildMetadataPath = ['resources', 'rmside-build.json'];
export const buildMetadataSchema = 'https://rmside.invalid/schemas/build-metadata/v1';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function run(command, args, options = {}) {
  process.stdout.write(`> ${command} ${args.join(' ')}\n`);
  const viaShell = process.platform === 'win32' && command === 'pnpm';
  const quoted = (value) => (/^[\w@./:=,\\-]+$/u.test(value) ? value : `"${value}"`);
  const result = spawnSync(
    viaShell ? [command, ...args].map(quoted).join(' ') : command,
    viaShell ? [] : args,
    {
      cwd: repositoryRoot,
      stdio: 'inherit',
      shell: viaShell,
      windowsHide: true,
      ...options,
      env: { ...process.env, ...options.env },
    },
  );
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status ?? result.signal}`);
  }
}

function git(...args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

export function sourceRevision() {
  try {
    const commit = git('rev-parse', '--short=7', 'HEAD');
    const dirty = git('status', '--porcelain', '--untracked-files=normal').length > 0;
    const time = Number(git('log', '-1', '--format=%ct', 'HEAD'));
    return {
      commit: dirty ? `${commit}-dirty` : commit,
      commitTime: Number.isSafeInteger(time) && time > 0 ? new Date(time * 1000) : null,
    };
  } catch {
    return { commit: 'unknown', commitTime: null };
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function filesUnder(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`unsupported packaged entry: ${relative(root, path)}`);
    }
  }
  return files
    .map((path) => ({ path, name: relative(root, path).replaceAll('\\', '/') }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function dosDateTime(date) {
  const value = date && date.getUTCFullYear() >= 1980 ? date : new Date(Date.UTC(1980, 0, 1));
  return {
    time:
      (value.getUTCHours() << 11) |
      (value.getUTCMinutes() << 5) |
      Math.floor(value.getUTCSeconds() / 2),
    date:
      ((value.getUTCFullYear() - 1980) << 9) |
      ((value.getUTCMonth() + 1) << 5) |
      value.getUTCDate(),
  };
}

const zipLimit = 0xffffffff;

export function writeZip(outputPath, entries, modified = null) {
  if (entries.length >= 0xffff) throw new Error('too many ZIP entries for a non-ZIP64 archive');
  const { time, date } = dosDateTime(modified);
  const central = [];
  const handle = openSync(outputPath, 'w');
  let offset = 0;
  const write = (buffer) => {
    writeSync(handle, buffer);
    offset += buffer.length;
    if (offset > zipLimit) throw new Error('the ZIP exceeds 4 GiB');
  };
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const data = entry.bytes();
      if (data.length > zipLimit) throw new Error(`${entry.name} exceeds 4 GiB`);
      const deflated = deflateRawSync(data, { level: 9 });
      const stored = deflated.length >= data.length;
      const body = stored ? data : deflated;
      const checksum = crc32(data);
      const method = stored ? 0 : 8;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const localOffset = offset;
      write(local);
      write(name);
      write(body);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(checksum, 16);
      header.writeUInt32LE(body.length, 20);
      header.writeUInt32LE(data.length, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(localOffset, 42);
      central.push(Buffer.concat([header, name]));
    }
    const centralOffset = offset;
    for (const header of central) write(header);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    write(end);
  } finally {
    closeSync(handle);
  }
}

export function readZipDirectory(bytes) {
  const endOffset = bytes.length - 22;
  if (endOffset < 0 || bytes.readUInt32LE(endOffset) !== 0x06054b50) {
    throw new Error('the ZIP end record is missing');
  }
  const count = bytes.readUInt16LE(endOffset + 10);
  let cursor = bytes.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error('a ZIP directory entry is invalid');
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    entries.push({
      name: bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      method: bytes.readUInt16LE(cursor + 10),
      crc32: bytes.readUInt32LE(cursor + 16),
      compressedSize: bytes.readUInt32LE(cursor + 20),
      size: bytes.readUInt32LE(cursor + 24),
      localOffset: bytes.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function packageVersion() {
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'));
  if (
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u.test(manifest.version)
  ) {
    throw new Error('the desktop package version is invalid');
  }
  return manifest.version;
}

export function packagePortable({
  editionName = 'full',
  outputDirectory = join(repositoryRoot, 'artifacts', 'packages'),
  checkPackage,
} = {}) {
  const edition = packageEdition(editionName);
  const output = resolve(outputDirectory);
  const version = packageVersion();
  const { commit, commitTime } = sourceRevision();
  const forgeOutput = join(desktopRoot, `out-${edition.edition}`);
  const packageRoot = join(forgeOutput, 'AoE2RMSIDE-win32-x64');
  const editionEnvironment = {
    RMSIDE_EDITION: edition.edition,
    RMSIDE_BUILD_COMMIT: commit,
    RMSIDE_FORGE_OUT_DIR: forgeOutput,
    RMSIDE_PRODUCT_DISPLAY_NAME: edition.displayName,
  };

  run('pnpm', ['--filter', '@rmside/desktop', 'build'], { env: editionEnvironment });
  buildReleaseNatives(nativeCargoPackages(edition).flatMap((name) => ['-p', name]));
  run('pwsh', [
    '-NoProfile',
    '-File',
    'tools/stage-native.ps1',
    '-Natives',
    edition.natives.join(','),
  ]);
  rmSync(forgeOutput, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 });
  run('pnpm', ['--filter', '@rmside/desktop', 'exec', 'electron-forge', 'package', '--arch=x64'], {
    env: editionEnvironment,
  });
  if (!existsSync(join(packageRoot, 'AoE2RMSIDE.exe'))) {
    throw new Error('Electron Forge did not produce the packaged application');
  }

  const natives = edition.natives.map((name) => {
    const bytes = readFileSync(join(packageRoot, 'resources', 'native', name));
    return { name, sha256: sha256(bytes), bytes: bytes.length };
  });
  const metadata = {
    $schema: buildMetadataSchema,
    product: 'AoE2RMSIDE',
    displayName: edition.displayName,
    edition: edition.edition,
    version,
    commit,
    platform: 'win32',
    arch: 'x64',
    natives,
  };
  writeFileSync(
    join(packageRoot, ...buildMetadataPath),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );

  if (checkPackage) checkPackage(packageRoot, edition);

  const stem = `${edition.artifactStem}-${version}-win32-x64`;
  mkdirSync(output, { recursive: true });
  const zipPath = join(output, `${stem}.zip`);
  const entries = filesUnder(packageRoot).map(({ path, name }) => ({
    name: `${stem}/${name}`,
    bytes: () => readFileSync(path),
  }));
  writeZip(zipPath, entries, commitTime);
  const zipBytes = readFileSync(zipPath);
  const zipSha256 = sha256(zipBytes);
  writeFileSync(`${zipPath}.sha256`, `${zipSha256}  ${basename(zipPath)}\n`, 'utf8');
  writeFileSync(
    join(output, `${stem}.build.json`),
    `${JSON.stringify(
      {
        ...metadata,
        artifact: { name: basename(zipPath), bytes: zipBytes.length, sha256: zipSha256 },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  process.stdout.write(
    `${basename(zipPath)}\n  ${zipBytes.length} bytes\n  sha256 ${zipSha256}\n  ${zipPath}\n`,
  );
  if (statSync(zipPath).size !== zipBytes.length) throw new Error('the ZIP changed while hashing');
  return { packageRoot, zipPath, sha256: zipSha256, bytes: zipBytes.length, stem };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    packagePortable({
      editionName: argument('--edition') ?? 'full',
      outputDirectory: argument('--output') ?? join(repositoryRoot, 'artifacts', 'packages'),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  }
}
