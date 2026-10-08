import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = join(repositoryRoot, 'apps', 'desktop');
const licenseTextsRoot = join(repositoryRoot, 'assets', 'third-party', 'license-texts');
export const noticesFileName = 'THIRD-PARTY-NOTICES.txt';
export const noticesHeading = 'AoE2RMSIDE third-party notices';
const rustTarget = 'x86_64-pc-windows-msvc';

export const recognizedLicenses = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'OFL-1.1',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'Zlib',
]);
const recognizedExceptions = new Set(['LLVM-exception']);

export const licenseOverrides = Object.freeze({
  'cargo:bcdec_rs': Object.freeze({
    version: '0.2.0',
    note: 'A Rust port of bcdec; the crate publishes no license file.',
    texts: Object.freeze([{ file: 'assets/third-party/bcdec_rs/LICENSE.txt' }]),
  }),
  'npm:@bufbuild/protobuf': Object.freeze({
    version: '2.14.0',
    note: 'Parts are derived from Protocol Buffers (BSD-3-Clause); the package publishes no license file.',
    texts: Object.freeze([
      { license: 'Apache-2.0' },
      { license: 'BSD-3-Clause', copyright: ['Copyright 2008 Google Inc.  All rights reserved.'] },
    ]),
  }),
});

export function licenseAlternatives(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new Error('no license is declared');
  }
  const tokens = expression
    .replace(/\s*\/\s*/gu, ' OR ')
    .replace(/([()])/gu, ' $1 ')
    .split(/\s+/u)
    .filter(Boolean);
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const primary = () => {
    const token = take();
    if (token === '(') {
      const inner = disjunction();
      if (take() !== ')') throw new Error(`unbalanced parentheses in ${expression}`);
      return inner;
    }
    if (!token || ['AND', 'OR', 'WITH', ')'].includes(token)) {
      throw new Error(`malformed license expression ${expression}`);
    }
    const license = token.replace(/\+$/u, '');
    if (!recognizedLicenses.has(license)) throw new Error(`unrecognized license ${token}`);
    if (peek() === 'WITH') {
      take();
      const exception = take();
      if (!recognizedExceptions.has(exception)) {
        throw new Error(`unrecognized license exception ${exception}`);
      }
      return [[`${license} WITH ${exception}`]];
    }
    return [[license]];
  };
  const conjunction = () => {
    let result = primary();
    while (peek() === 'AND') {
      take();
      const right = primary();
      result = result.flatMap((left) => right.map((term) => [...left, ...term]));
    }
    return result;
  };
  const disjunction = () => {
    let result = conjunction();
    while (peek() === 'OR') {
      take();
      result = [...result, ...conjunction()];
    }
    return result;
  };
  const alternatives = disjunction();
  if (index !== tokens.length) throw new Error(`malformed license expression ${expression}`);
  return alternatives;
}

const licenseFilePattern =
  /^(?:licen[cs]e|copying|notice|copyright|unlicense|third[-_]?party[-_]?notices?)(?:[-._][^\\/]*)?$/iu;

export function licenseFilesIn(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => ({ name, text: readText(join(directory, name)) }));
}

function readText(path) {
  const text = readFileSync(path, 'utf8').replace(/^﻿/u, '').replace(/\r\n?/gu, '\n');
  return text.trimEnd();
}

function standardText(license) {
  const base = license.split(' WITH ')[0];
  const path = join(licenseTextsRoot, `${base}.txt`);
  if (!existsSync(path)) return undefined;
  const text = readText(path);
  if (!license.includes(' WITH ')) return text;
  const exception = join(licenseTextsRoot, `${license.split(' WITH ')[1]}.txt`);
  return existsSync(exception) ? `${text}\n\n${readText(exception)}` : undefined;
}

export function filledLicenseText(license, copyright, textFor = standardText) {
  const text = textFor(license);
  if (text === undefined) return undefined;
  if (text.includes('{{copyright}}')) {
    if (copyright.length === 0) return undefined;
    return text.replace('{{copyright}}', copyright.join('\n'));
  }
  return copyright.length > 0 ? `${copyright.join('\n')}\n\n${text}` : text;
}

/** Copyright lines from package authors (names only; addresses are dropped). */
export function copyrightFromAuthors(authors) {
  const names = (authors ?? [])
    .map((author) =>
      (typeof author === 'string' ? author : (author?.name ?? ''))
        .replace(/<[^>]*>|\([^)]*\)/gu, '')
        .trim(),
    )
    .filter(Boolean);
  return names.length > 0 ? [`Copyright (c) ${names.join(', ')}`] : [];
}

export function packageLicenseTexts(
  pkg,
  { textFor = standardText, overrides = licenseOverrides } = {},
) {
  const label = `${pkg.name} ${pkg.version}`;
  const alternatives = licenseAlternatives(pkg.license);
  const override = overrides[`${pkg.ecosystem}:${pkg.name}`];
  if (override) {
    if (override.version !== pkg.version) {
      throw new Error(
        `${label}: the reviewed license texts are for version ${override.version}; review the license of this version`,
      );
    }
    return {
      note: override.note,
      texts: override.texts.map((entry) => {
        if (entry.file) {
          return { title: `${pkg.name} license`, text: readText(join(repositoryRoot, entry.file)) };
        }
        const text = filledLicenseText(entry.license, entry.copyright ?? [], textFor);
        if (text === undefined) throw new Error(`${label}: no standard text for ${entry.license}`);
        return { title: entry.license, text };
      }),
    };
  }
  if (pkg.files.length > 0) {
    return { texts: pkg.files.map((file) => ({ title: file.name, text: file.text })) };
  }
  const written = (licenses, copyright) => {
    const texts = licenses.map((license) => ({
      title: license,
      text: filledLicenseText(license, copyright, textFor),
    }));
    return texts.every((entry) => entry.text !== undefined) ? texts : undefined;
  };
  const copyright = copyrightFromAuthors(pkg.authors);
  const chosen =
    alternatives.map((licenses) => written(licenses, [])).find(Boolean) ??
    alternatives.map((licenses) => written(licenses, copyright)).find(Boolean);
  if (!chosen) {
    throw new Error(
      `${label}: publishes no license file, and no standard text of ${pkg.license} can be written (missing text or copyright holder)`,
    );
  }
  return {
    note: 'The package publishes no license file; this is the standard text of its declared license.',
    texts: chosen,
  };
}

function run(command, args) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export function rustPackages(natives) {
  const cargoNames = natives.map((name) => name.replace(/\.exe$/iu, ''));
  const tree = run('cargo', [
    'tree',
    '--manifest-path',
    join(repositoryRoot, 'Cargo.toml'),
    ...cargoNames.flatMap((name) => ['-p', name]),
    '-e',
    'normal',
    '--target',
    rustTarget,
    '--no-default-features',
    '--prefix',
    'none',
    '--format',
    '{p}',
    '--locked',
    '--offline',
  ]);
  const wanted = new Set();
  for (const line of tree.split(/\r?\n/u)) {
    const match = /^(\S+) v(\S+)/u.exec(line.trim());
    if (match) wanted.add(`${match[1]}@${match[2]}`);
  }
  const metadata = JSON.parse(
    run('cargo', [
      'metadata',
      '--manifest-path',
      join(repositoryRoot, 'Cargo.toml'),
      '--format-version',
      '1',
      '--filter-platform',
      rustTarget,
      '--locked',
      '--offline',
    ]),
  );
  const packages = [];
  for (const pkg of metadata.packages) {
    if (!wanted.has(`${pkg.name}@${pkg.version}`) || pkg.source === null) continue;
    const directory = dirname(pkg.manifest_path);
    const files = licenseFilesIn(directory);
    if (pkg.license_file) {
      const path = resolve(directory, pkg.license_file);
      if (existsSync(path) && !files.some((file) => resolve(directory, file.name) === path)) {
        files.push({ name: pkg.license_file.replaceAll('\\', '/'), text: readText(path) });
      }
    }
    packages.push({
      ecosystem: 'cargo',
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      authors: pkg.authors,
      repository: pkg.repository ?? undefined,
      files,
    });
  }
  return sortPackages(packages);
}

function npmRepository(manifest) {
  const value =
    typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (typeof value !== 'string') return manifest.homepage ?? undefined;
  return value.replace(/^git\+/u, '').replace(/\.git$/u, '');
}

function npmLicense(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses.map((entry) => entry?.type ?? entry).join(' OR ');
  }
  return undefined;
}

export function npmPackages(recordsDirectory = join(desktopRoot, 'dist', 'bundled-packages')) {
  const found = new Map();
  for (const target of ['main', 'preload', 'renderer']) {
    const path = join(recordsDirectory, `${target}.json`);
    if (!existsSync(path)) {
      throw new Error(
        `the desktop build's bundled-package record ${target}.json is missing; run pnpm build`,
      );
    }
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.schemaVersion !== 1 || !Array.isArray(record.packages)) {
      throw new Error(`the bundled-package record ${target}.json is not version 1`);
    }
    for (const entry of record.packages) {
      const directory = resolve(repositoryRoot, entry.directory);
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest.name !== entry.name || manifest.version !== entry.version) {
        throw new Error(
          `${entry.name} ${entry.version} is no longer installed as recorded; rebuild the desktop bundles`,
        );
      }
      found.set(`${entry.name}@${entry.version}`, {
        ecosystem: 'npm',
        name: entry.name,
        version: entry.version,
        license: npmLicense(manifest),
        authors: manifest.author ? [manifest.author] : (manifest.contributors ?? []),
        repository: npmRepository(manifest),
        files: licenseFilesIn(directory),
      });
    }
  }
  return sortPackages([...found.values()]);
}

function sortPackages(packages) {
  return packages.sort((left, right) =>
    left.name === right.name
      ? left.version.localeCompare(right.version, 'en', { numeric: true })
      : left.name.toLowerCase() < right.name.toLowerCase()
        ? -1
        : left.name.toLowerCase() > right.name.toLowerCase()
          ? 1
          : left.name < right.name
            ? -1
            : 1,
  );
}

export function rustStandardLibraryNotices() {
  const sysroot = run('rustc', ['--print', 'sysroot']).trim();
  const path = join(sysroot, 'share', 'doc', 'rust', 'COPYRIGHT-library.html');
  if (!existsSync(path)) {
    throw new Error('the Rust toolchain has no COPYRIGHT-library.html for the standard library');
  }
  return htmlToText(readFileSync(path, 'utf8'));
}

export function htmlToText(html) {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/giu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(?:p|h[1-6]|li|pre|div|tr|ul|ol|blockquote|table)>/giu, '\n\n')
    .replace(/<li\b[^>]*>/giu, '- ')
    .replace(/<[^>]+>/gu, '')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&(?:#39|apos);/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/gu, '&')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function noticesDocument({ natives, rust, npm, rustStandardLibrary }) {
  const texts = new Map();
  const reference = ({ title, text }) => {
    const key = createHash('sha256').update(text.replace(/\s+/gu, ' ').trim()).digest('hex');
    if (!texts.has(key)) texts.set(key, { number: texts.size + 1, title, text, users: [] });
    return texts.get(key);
  };
  const failures = [];
  const listing = (packages) =>
    packages.flatMap((pkg) => {
      let resolved;
      try {
        resolved = packageLicenseTexts(pkg);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        return [];
      }
      const entries = resolved.texts.map(reference);
      for (const entry of entries) entry.users.push(`${pkg.name} ${pkg.version}`);
      return [
        `${pkg.name} ${pkg.version}`,
        `  License: ${pkg.license}`,
        ...(pkg.repository ? [`  Source: ${pkg.repository}`] : []),
        ...(resolved.note ? [`  Note: ${resolved.note}`] : []),
        `  License texts: ${entries.map((entry) => `[${entry.number}]`).join(' ')}`,
        '',
      ];
    });
  const lines = [
    noticesHeading,
    '='.repeat(noticesHeading.length),
    '',
    'AoE2RMSIDE is licensed under the Apache License, Version 2.0. This package',
    'also contains the third-party software listed below, each under its own',
    'license. Every license text follows the list once; each entry names the',
    'texts that apply to it.',
    '',
    'Also part of this package, with their own notices:',
    '- Electron and Chromium: LICENSE and LICENSES.chromium.html beside',
    '  AoE2RMSIDE.exe.',
    '- The Inter typeface: resources/inter/LICENSE.txt.',
    '',
  ];
  if (natives.length > 0) {
    const heading = `Native programs (${natives.join(', ')})`;
    const standard = reference({
      title: 'Rust standard library notices',
      text: rustStandardLibrary,
    });
    standard.users.push('Rust standard library');
    lines.push(
      heading,
      '-'.repeat(heading.length),
      '',
      'Rust standard library',
      '  License: MIT OR Apache-2.0 (with the notices of its own dependencies)',
      `  License texts: [${standard.number}]`,
      '',
      ...listing(rust),
    );
  }
  const heading = 'Application (bundled JavaScript, styles, and fonts)';
  lines.push(heading, '-'.repeat(heading.length), '', ...listing(npm));
  if (failures.length > 0) {
    throw new Error(
      `third-party license review failed:\n- ${failures.join('\n- ')}\nAdd a reviewed license text in tools/third-party-notices.mjs or replace the dependency.`,
    );
  }
  lines.push('License texts', '=============', '');
  for (const entry of texts.values()) {
    const title = `[${entry.number}] ${entry.title}`;
    lines.push(title, `Used by: ${entry.users.join(', ')}`, '', entry.text, '', '-'.repeat(72), '');
  }
  return `${lines
    .join('\r\n')
    .replace(/\n/gu, '\r\n')
    .replace(/\r\r\n/gu, '\r\n')
    .trimEnd()}\r\n`;
}

export function writeNotices(natives, output) {
  const unknown = natives.filter((name) => !/^[a-z][a-z0-9-]*\.exe$/u.test(name));
  if (unknown.length > 0) throw new Error(`invalid native names: ${unknown.join(', ')}`);
  const document = noticesDocument({
    natives,
    rust: natives.length > 0 ? rustPackages(natives) : [],
    npm: npmPackages(),
    rustStandardLibrary: natives.length > 0 ? rustStandardLibraryNotices() : '',
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, document, 'utf8');
  return document;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const natives = (argument('--natives') ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const output = argument('--output');
    if (!output) throw new Error('--output names the notices file to write');
    const document = writeNotices(natives, resolve(output));
    const count = (document.match(/^ {2}License: /gmu) ?? []).length;
    process.stdout.write(
      `Wrote third-party notices for ${count} components (${statSync(resolve(output)).size} bytes).\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
