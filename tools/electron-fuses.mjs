import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
export const supportedFuseWireVersion = 1;

export const fuseIndexes = Object.freeze({
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
  LoadBrowserProcessSpecificV8Snapshot: 6,
  GrantFileProtocolExtraPrivileges: 7,
  WasmTrapHandlers: 8,
});
const fuseNames = Object.keys(fuseIndexes);

export const productionFuses = Object.freeze({
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
  WasmTrapHandlers: true,
});

export const inspectableTestCopyFuses = Object.freeze({
  ...productionFuses,
  EnableNodeCliInspectArguments: true,
});

function sentinelOffset(bytes) {
  const offset = bytes.indexOf(sentinel);
  if (offset < 0) throw new Error('the executable has no Electron fuse wire');
  if (bytes.indexOf(sentinel, offset + 1) >= 0) {
    throw new Error('the executable has more than one Electron fuse wire');
  }
  return offset;
}

export function readFuseWire(bytes) {
  const offset = sentinelOffset(bytes);
  const versionOffset = offset + sentinel.length;
  if (versionOffset + 2 > bytes.length) throw new Error('the Electron fuse wire is truncated');
  const version = bytes[versionOffset];
  if (version !== supportedFuseWireVersion) {
    throw new Error(`unsupported Electron fuse wire version ${version}`);
  }
  const length = bytes[versionOffset + 1];
  const start = versionOffset + 2;
  if (start + length > bytes.length) throw new Error('the Electron fuse wire is truncated');
  const states = [];
  for (let index = 0; index < length; index += 1) {
    const value = bytes[start + index];
    if (value === 0x30) states.push('off');
    else if (value === 0x31) states.push('on');
    else if (value === 0x72) states.push('removed');
    else throw new Error(`Electron fuse ${index} has an unknown state byte ${value}`);
  }
  return { version, start, states };
}

function assertDecidedWire(wire) {
  if (wire.states.length !== fuseNames.length) {
    throw new Error(
      `the Electron fuse wire has ${wire.states.length} fuses, not the ${fuseNames.length} decided in tools/electron-fuses.mjs; decide the new fuses before packaging`,
    );
  }
}

function assertCompleteConfiguration(configuration) {
  for (const name of Object.keys(configuration)) {
    if (!Object.hasOwn(fuseIndexes, name)) throw new Error(`unknown Electron fuse ${name}`);
  }
  for (const name of fuseNames) {
    if (typeof configuration[name] !== 'boolean') {
      throw new Error(`Electron fuse ${name} is not decided`);
    }
  }
}

export function withFuses(bytes, configuration) {
  assertCompleteConfiguration(configuration);
  const wire = readFuseWire(bytes);
  assertDecidedWire(wire);
  const result = Buffer.from(bytes);
  for (const name of fuseNames) {
    const index = fuseIndexes[name];
    if (wire.states[index] === 'removed') {
      throw new Error(`Electron fuse ${name} was removed from this Electron`);
    }
    result[wire.start + index] = configuration[name] ? 0x31 : 0x30;
  }
  return result;
}

export function fuseViolations(bytes, configuration = productionFuses) {
  assertCompleteConfiguration(configuration);
  let wire;
  try {
    wire = readFuseWire(bytes);
    assertDecidedWire(wire);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const violations = [];
  for (const name of fuseNames) {
    const expected = configuration[name] ? 'on' : 'off';
    const actual = wire.states[fuseIndexes[name]];
    if (actual !== expected) violations.push(`Electron fuse ${name} is ${actual}, not ${expected}`);
  }
  return violations;
}

export function asarHeaderSha256(bytes) {
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw new Error('app.asar has no header');
  const headerPickleSize = bytes.readUInt32LE(4);
  const stringLength = bytes.readInt32LE(12);
  if (
    stringLength < 2 ||
    headerPickleSize < stringLength + 8 ||
    8 + headerPickleSize > bytes.length ||
    16 + stringLength > bytes.length
  ) {
    throw new Error('app.asar has an invalid header');
  }
  return createHash('sha256')
    .update(bytes.subarray(16, 16 + stringLength))
    .digest('hex');
}

export function embeddedAsarIntegrity(bytes) {
  const marker = Buffer.from('[{"file":"', 'latin1');
  const records = [];
  for (
    let offset = bytes.indexOf(marker);
    offset >= 0;
    offset = bytes.indexOf(marker, offset + 1)
  ) {
    const end = bytes.indexOf(Buffer.from('}]', 'latin1'), offset);
    if (end < 0 || end - offset > 64 * 1024) continue;
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8', offset, end + 2));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry.file === 'string' &&
        typeof entry.alg === 'string' &&
        typeof entry.value === 'string'
      ) {
        records.push({ file: entry.file, alg: entry.alg, value: entry.value });
      }
    }
  }
  return records;
}

export function asarIntegrityViolations(executableBytes, asarBytes) {
  const records = embeddedAsarIntegrity(executableBytes).filter(
    (record) => record.file.replaceAll('/', '\\').toLowerCase() === 'resources\\app.asar',
  );
  if (records.length !== 1) {
    return [
      `the executable has ${records.length} integrity records for resources\\app.asar, not 1`,
    ];
  }
  const [record] = records;
  if (record.alg !== 'SHA256') return [`app.asar integrity uses ${record.alg}, not SHA256`];
  let actual;
  try {
    actual = asarHeaderSha256(asarBytes);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  return record.value.toLowerCase() === actual
    ? []
    : ['the embedded app.asar integrity does not match the packaged app.asar header'];
}

export function packagedHardeningViolations(packageRoot, configuration = productionFuses) {
  const executablePath = join(packageRoot, 'AoE2RMSIDE.exe');
  const asarPath = join(packageRoot, 'resources', 'app.asar');
  if (!existsSync(executablePath)) return ['the packaged AoE2RMSIDE.exe is missing'];
  if (!existsSync(asarPath)) return ['the packaged app.asar is missing'];
  const asarSize = statSync(asarPath).size;
  if (asarSize < 16 || asarSize > 512 * 1024 * 1024) return ['the packaged app.asar is invalid'];
  const executable = readFileSync(executablePath);
  return [
    ...fuseViolations(executable, configuration),
    ...asarIntegrityViolations(executable, readFileSync(asarPath)),
  ];
}

export function applyFuses(executablePath, configuration = productionFuses) {
  const original = readFileSync(executablePath);
  writeFileSync(executablePath, withFuses(original, configuration));
  const violations = packagedHardeningViolations(dirname(executablePath), configuration);
  if (violations.length > 0) {
    throw new Error(`packaged Electron hardening failed:\n- ${violations.join('\n- ')}`);
  }
}

function syntheticExecutable(states, version = supportedFuseWireVersion, extra = '') {
  return Buffer.concat([
    Buffer.from('MZ padding '),
    sentinel,
    Buffer.from([version, states.length]),
    Buffer.from(states, 'latin1'),
    Buffer.from(` tail ${extra}`),
  ]);
}

function syntheticAsar(header) {
  const json = Buffer.from(header, 'utf8');
  const padded = (json.length + 3) & ~3;
  const bytes = Buffer.alloc(16 + padded + 4);
  bytes.writeUInt32LE(4, 0);
  bytes.writeUInt32LE(8 + padded, 4);
  bytes.writeUInt32LE(4 + padded, 8);
  bytes.writeInt32LE(json.length, 12);
  json.copy(bytes, 16);
  return bytes;
}

function expectThrows(operation, label) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`electron fuse self-test accepted ${label}`);
}

export function fuseSelfTest() {
  const stock = syntheticExecutable('101100011');
  const fused = withFuses(stock, productionFuses);
  if (fused.length !== stock.length) throw new Error('electron fuse self-test changed the size');
  if (readFuseWire(fused).states.join(',') !== 'off,on,off,off,on,on,off,off,on') {
    throw new Error('electron fuse self-test wrote the wrong production wire');
  }
  if (fuseViolations(fused).length !== 0) throw new Error('electron fuse self-test rejected fuses');
  if (fuseViolations(stock).length !== 7) {
    throw new Error('electron fuse self-test missed a stock Electron fuse');
  }
  const inspectable = withFuses(fused, inspectableTestCopyFuses);
  const inspectableViolations = fuseViolations(inspectable);
  if (
    inspectableViolations.length !== 1 ||
    !inspectableViolations[0].includes('EnableNodeCliInspectArguments')
  ) {
    throw new Error('electron fuse self-test accepted the inspectable copy as production');
  }
  expectThrows(() => readFuseWire(Buffer.from('MZ no wire')), 'a missing wire');
  expectThrows(() => readFuseWire(syntheticExecutable('101100011', 2)), 'wire version 2');
  expectThrows(
    () => readFuseWire(syntheticExecutable('1', 1, sentinel.toString('latin1'))),
    'two wires',
  );
  expectThrows(() => readFuseWire(syntheticExecutable('10x100011')), 'an unknown state byte');
  expectThrows(() => withFuses(syntheticExecutable('1011000110'), productionFuses), 'a new fuse');
  expectThrows(
    () => withFuses(syntheticExecutable('r01100011'), productionFuses),
    'a removed fuse',
  );
  expectThrows(
    () => withFuses(stock, { ...productionFuses, RunAsNode: undefined }),
    'an undecided fuse',
  );
  expectThrows(() => withFuses(stock, { ...productionFuses, Unknown: true }), 'an unknown fuse');
  if (fuseViolations(syntheticExecutable('0100110110')).length !== 1) {
    throw new Error('electron fuse self-test accepted an undecided new fuse');
  }

  const asar = syntheticAsar('{"files":{"main.cjs":{"size":1,"offset":"0"}}}');
  const hash = asarHeaderSha256(asar);
  const record = (value, alg = 'SHA256') =>
    `[{"file":"resources\\\\app.asar","alg":"${alg}","value":"${value}"}]`;
  if (asarIntegrityViolations(syntheticExecutable('0', 1, record(hash)), asar).length !== 0) {
    throw new Error('electron fuse self-test rejected a matching asar integrity record');
  }
  for (const [label, executable] of [
    ['a missing integrity record', syntheticExecutable('0')],
    ['a mismatching integrity record', syntheticExecutable('0', 1, record('0'.repeat(64)))],
    ['another integrity algorithm', syntheticExecutable('0', 1, record(hash, 'SHA512'))],
    ['two integrity records', syntheticExecutable('0', 1, `${record(hash)} ${record(hash)}`)],
  ]) {
    if (asarIntegrityViolations(executable, asar).length !== 1) {
      throw new Error(`electron fuse self-test accepted ${label}`);
    }
  }
  expectThrows(() => asarHeaderSha256(Buffer.from('not an asar archive')), 'an invalid asar');
}
