import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function spellings(path, realpath) {
  const values = new Set();
  const add = (value) => {
    if (!value) return;
    const trimmed = value.replace(/[\\/]+$/u, '');
    if (!trimmed) return;
    values.add(trimmed);
    if (/^[A-Za-z]:/u.test(trimmed)) {
      values.add(trimmed[0].toUpperCase() + trimmed.slice(1));
      values.add(trimmed[0].toLowerCase() + trimmed.slice(1));
    }
  };
  if (!path) return [];
  add(path);
  try {
    add(realpath(path.replace(/[\\/]+$/u, '')));
  } catch {}
  return [...values];
}

export function remapPathFlags({
  env = process.env,
  home = homedir(),
  root = repositoryRoot,
  realpath = realpathSync.native,
} = {}) {
  const prefixes = [
    [home, '~'],
    [env.CARGO_HOME?.trim() || join(home, '.cargo'), 'cargo-home'],
    [env.RUSTUP_HOME?.trim() || join(home, '.rustup'), 'rustup-home'],
    [root, 'rmside'],
    [env.CARGO_TARGET_DIR?.trim() ? resolve(root, env.CARGO_TARGET_DIR.trim()) : '', 'target'],
  ];
  const mappings = new Map();
  for (const [path, replacement] of prefixes) {
    for (const spelling of spellings(path, realpath)) mappings.set(spelling, replacement);
  }
  return [...mappings]
    .sort(([left], [right]) => left.length - right.length || (left < right ? -1 : 1))
    .map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
}

export function releaseBuildEnvironment(env = process.env, options = {}) {
  const existing =
    env.CARGO_ENCODED_RUSTFLAGS !== undefined
      ? env.CARGO_ENCODED_RUSTFLAGS.split('\x1f').filter(Boolean)
      : (env.RUSTFLAGS ?? '').split(/\s+/u).filter(Boolean);
  return {
    ...env,
    CARGO_ENCODED_RUSTFLAGS: [...existing, ...remapPathFlags({ env, ...options })].join('\x1f'),
  };
}

export function releaseBuildArguments(selection) {
  return [
    'build',
    '--manifest-path',
    join(repositoryRoot, 'Cargo.toml'),
    '--release',
    '--locked',
    '--no-default-features',
    ...selection,
  ];
}

export function buildReleaseNatives(selection, { env = process.env } = {}) {
  const args = releaseBuildArguments(selection);
  process.stdout.write(`> cargo ${args.join(' ')} (source paths remapped)\n`);
  const result = spawnSync('cargo', args, {
    cwd: repositoryRoot,
    env: releaseBuildEnvironment(env),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`the release native build failed with ${result.status ?? result.signal}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const selection = process.argv.slice(2);
    if (selection.length === 0) throw new Error('name --workspace or -p <package> to build');
    buildReleaseNatives(selection);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
