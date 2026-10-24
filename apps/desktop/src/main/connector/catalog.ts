import { createHash } from 'node:crypto';
import {
  connectorErrorCodes,
  connectorToolNames,
  type ConnectorErrorCode,
  type ConnectorToolName,
} from '../../shared/connector-api';
import type { ConnectorSchemaNode } from './validator';

export const catalogHashRule = 'rmside-connect-catalog-v1';
export const catalogManifestPath = 'catalog.json';
const maximumCatalogFiles = 64;
const maximumCatalogBytes = 4 * 1024 * 1024;

export type ConnectorLane = 'none' | 'always' | 'when-generating';
export type ConnectorConfirmation = 'none' | 'setting' | 'when-replacing' | 'always';

export interface ConnectorCatalogTool {
  name: ConnectorToolName;
  title: string;
  servedBy: 'ide' | 'connector';
  lane: ConnectorLane;
  confirmation: ConnectorConfirmation;
  readOnly: boolean;
  inputSchema: ConnectorSchemaNode;
  output: { maxChars: number; image: boolean };
}

export interface ConnectorLimits {
  frameBytes: number;
  argumentsJsonBytes: number;
  textItemBytes: number;
  pngBytes: number;
  imageMaxSide: number;
  imageMinLongSide: number;
  connections: number;
  callsInFlight: number;
  callsPerMinute: number;
  picturesPerMinute: number;
  handshakeSeconds: number;
  pairingWaitSeconds: number;
  busyWaitSeconds: number;
  defaultWaitSeconds: number;
  maxWaitSeconds: number;
  promptAnswerSeconds: number;
  progressPerSecond: number;
  stdinLineBytes: number;
  qualityCheckMaps: number;
}

const limitKeys: readonly (keyof ConnectorLimits)[] = [
  'frameBytes',
  'argumentsJsonBytes',
  'textItemBytes',
  'pngBytes',
  'imageMaxSide',
  'imageMinLongSide',
  'connections',
  'callsInFlight',
  'callsPerMinute',
  'picturesPerMinute',
  'handshakeSeconds',
  'pairingWaitSeconds',
  'busyWaitSeconds',
  'defaultWaitSeconds',
  'maxWaitSeconds',
  'promptAnswerSeconds',
  'progressPerSecond',
  'stdinLineBytes',
  'qualityCheckMaps',
];

export interface ConnectorCatalog {
  hash: Uint8Array;
  hashHex: string;
  limits: ConnectorLimits;
  errorCodes: readonly ConnectorErrorCode[];
  qualityCases: readonly string[];
  tools: ReadonlyMap<ConnectorToolName, ConnectorCatalogTool>;
}

export interface ConnectorCatalogFile {
  path: string;
  text: string;
}

export class ConnectorCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorCatalogError';
  }
}

function isCatalogPath(path: string): boolean {
  return (
    path.length <= 96 &&
    path !== catalogManifestPath &&
    path
      .split('/')
      .every(
        (segment) =>
          segment !== '' && segment !== '.' && segment !== '..' && /^[a-z0-9._-]+$/u.test(segment),
      )
  );
}

export function canonicalCatalogBytes(files: readonly ConnectorCatalogFile[]): Buffer {
  if (files.length === 0 || files.length > maximumCatalogFiles) {
    throw new ConnectorCatalogError('the catalog has no files or too many');
  }
  const sorted = [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  const parts: Buffer[] = [Buffer.from(`${catalogHashRule}\n`)];
  let total = parts[0]!.length;
  let previous: string | undefined;
  for (const { path, text } of sorted) {
    if (!isCatalogPath(path)) throw new ConnectorCatalogError(`catalog path ${path} is invalid`);
    if (previous === path) throw new ConnectorCatalogError(`catalog path ${path} is repeated`);
    previous = path;
    if (text.startsWith('﻿')) {
      throw new ConnectorCatalogError(`catalog file ${path} has a byte order mark`);
    }
    const normalized = text.replaceAll('\r\n', '\n');
    if (normalized.includes('\r')) {
      throw new ConnectorCatalogError(`catalog file ${path} holds a lone carriage return`);
    }
    const content = Buffer.from(normalized, 'utf8');
    const part = Buffer.concat([
      Buffer.from(`${path}\n${content.length}\n`),
      content,
      Buffer.from('\n'),
    ]);
    total += part.length;
    if (total > maximumCatalogBytes) throw new ConnectorCatalogError('the catalog is too large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConnectorCatalogError(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function sameList(actual: unknown, expected: readonly string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ConnectorCatalogError(`${label} differs from this build's list`);
  }
}

export function loadConnectorCatalog(files: readonly ConnectorCatalogFile[]): ConnectorCatalog {
  const manifestFile = files.find((file) => file.path === catalogManifestPath);
  if (!manifestFile) throw new ConnectorCatalogError('catalog.json is missing');
  const catalogFiles = files.filter((file) => file.path !== catalogManifestPath);
  const manifest = object(JSON.parse(manifestFile.text), 'catalog.json');
  if (manifest.hashRule !== catalogHashRule) {
    throw new ConnectorCatalogError('catalog.json names another hash rule');
  }
  if (
    typeof manifest.schemaVersion !== 'string' ||
    !/^1\.\d+\.\d+$/u.test(manifest.schemaVersion)
  ) {
    throw new ConnectorCatalogError('catalog.json is not a supported 1.x manifest');
  }
  const paths = catalogFiles.map((file) => file.path).sort();
  sameList(manifest.files, paths, 'catalog.json files');
  const hash = createHash('sha256').update(canonicalCatalogBytes(catalogFiles)).digest();
  const hashHex = hash.toString('hex');
  if (manifest.sha256 !== hashHex) {
    throw new ConnectorCatalogError('the catalog hash differs from catalog.json');
  }
  const toolsFile = catalogFiles.find((file) => file.path === 'tools.v1.json');
  if (!toolsFile) throw new ConnectorCatalogError('tools.v1.json is missing');
  const tools = object(JSON.parse(toolsFile.text), 'tools.v1.json');
  if (typeof tools.schemaVersion !== 'string' || !/^1\.\d+\.\d+$/u.test(tools.schemaVersion)) {
    throw new ConnectorCatalogError('tools.v1.json is not a supported 1.x catalog');
  }
  const compatibility = object(tools.compatibility, 'tools compatibility');
  if (
    typeof compatibility.minimumMajor !== 'number' ||
    typeof compatibility.maximumMajor !== 'number' ||
    compatibility.minimumMajor > 1 ||
    compatibility.maximumMajor < 1
  ) {
    throw new ConnectorCatalogError('tools.v1.json does not cover protocol major 1');
  }
  const rawLimits = object(tools.limits, 'tools limits');
  const limits = {} as ConnectorLimits;
  for (const key of limitKeys) {
    const value = rawLimits[key];
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new ConnectorCatalogError(`limit ${key} is missing or not a positive integer`);
    }
    limits[key] = value as number;
  }
  sameList(tools.errorCodes, connectorErrorCodes, 'tools errorCodes');
  if (
    !Array.isArray(tools.qualityCases) ||
    !tools.qualityCases.every((id) => typeof id === 'string')
  ) {
    throw new ConnectorCatalogError('tools qualityCases is not a list of ids');
  }
  if (!Array.isArray(tools.tools)) throw new ConnectorCatalogError('tools.v1.json has no tools');
  sameList(
    tools.tools.map((tool) => (tool as { name?: unknown } | null)?.name),
    connectorToolNames,
    'tool names',
  );
  const toolMap = new Map<ConnectorToolName, ConnectorCatalogTool>();
  for (const entry of tools.tools as unknown[]) {
    const tool = object(entry, 'tool');
    const name = tool.name as ConnectorToolName;
    const annotations = object(tool.annotations, `${name} annotations`);
    const output = object(tool.output, `${name} output`);
    const inputSchema = object(tool.inputSchema, `${name} inputSchema`);
    if (inputSchema.type !== 'object') {
      throw new ConnectorCatalogError(`${name} input is not an object schema`);
    }
    if (!Number.isSafeInteger(output.maxChars) || typeof output.image !== 'boolean') {
      throw new ConnectorCatalogError(`${name} output is invalid`);
    }
    if (!['ide', 'connector'].includes(tool.servedBy as string)) {
      throw new ConnectorCatalogError(`${name} servedBy is unknown`);
    }
    if (!['none', 'always', 'when-generating'].includes(tool.lane as string)) {
      throw new ConnectorCatalogError(`${name} lane is unknown`);
    }
    if (!['none', 'setting', 'when-replacing', 'always'].includes(tool.confirmation as string)) {
      throw new ConnectorCatalogError(`${name} confirmation is unknown`);
    }
    toolMap.set(name, {
      name,
      title: String(tool.title),
      servedBy: tool.servedBy as 'ide' | 'connector',
      lane: tool.lane as ConnectorLane,
      confirmation: tool.confirmation as ConnectorConfirmation,
      readOnly: annotations.readOnlyHint === true,
      inputSchema: inputSchema as unknown as ConnectorSchemaNode,
      output: { maxChars: output.maxChars as number, image: output.image },
    });
  }
  return Object.freeze({
    hash: new Uint8Array(hash),
    hashHex,
    limits: Object.freeze(limits),
    errorCodes: connectorErrorCodes,
    qualityCases: Object.freeze([...(tools.qualityCases as string[])]),
    tools: toolMap,
  });
}

export function bundledConnectorCatalogFiles(): ConnectorCatalogFile[] {
  const modules = import.meta.glob<string>('../../../../../connector/**/*', {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  const prefix = '../../../../../connector/';
  return Object.entries(modules).map(([key, text]) => {
    if (!key.startsWith(prefix)) throw new ConnectorCatalogError('unexpected catalog module');
    return { path: key.slice(prefix.length), text };
  });
}

let bundled: ConnectorCatalog | ConnectorCatalogError | undefined;

export function bundledConnectorCatalog(): ConnectorCatalog {
  if (bundled === undefined) {
    try {
      bundled = loadConnectorCatalog(bundledConnectorCatalogFiles());
    } catch (error) {
      bundled =
        error instanceof ConnectorCatalogError
          ? error
          : new ConnectorCatalogError(`the catalog could not be read: ${String(error)}`);
    }
  }
  if (bundled instanceof ConnectorCatalogError) throw bundled;
  return bundled;
}
