import { open } from 'node:fs/promises';

export interface PeByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export const peVersionLimits = {
  maximumReadBytes: 256 * 1024,
  maximumReads: 64,
  maximumPeHeaderOffset: 1024 * 1024,
  maximumSections: 96,
  maximumOptionalHeaderBytes: 4096,
  maximumDirectoryEntries: 1024,
  maximumVersionResourceBytes: 0xffff,
  maximumVersionDepth: 6,
  maximumVersionNodes: 2048,
  maximumProductVersionLength: 64,
} as const;

const resourceTypeVersion = 16;
const preferredVersionResourceId = 1;
const defaultTranslation = '040904E4';
const fallbackTranslations = ['040904B0', '040904E4', '04090000'] as const;

class MalformedPe extends Error {}

function malformed(reason: string): never {
  throw new MalformedPe(reason);
}

class BudgetedReader {
  private bytesRead = 0;
  private reads = 0;

  constructor(private readonly source: PeByteSource) {}

  get size(): number {
    return this.source.size;
  }

  async exact(offset: number, length: number): Promise<Buffer> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.source.size
    ) {
      malformed('read is outside the file');
    }
    if (length === 0) return Buffer.alloc(0);
    this.reads += 1;
    this.bytesRead += length;
    if (
      this.reads > peVersionLimits.maximumReads ||
      this.bytesRead > peVersionLimits.maximumReadBytes
    ) {
      malformed('read budget exceeded');
    }
    const bytes = await this.source.read(offset, length);
    if (bytes.byteLength < length) malformed('file is truncated');
    return Buffer.from(bytes.buffer, bytes.byteOffset, length);
  }
}

interface Section {
  virtualAddress: number;
  rawSize: number;
  rawOffset: number;
}

interface ImageLayout {
  resourceRva: number;
  sections: Section[];
}

async function readLayout(reader: BudgetedReader): Promise<ImageLayout | null> {
  const dos = await reader.exact(0, 64);
  if (dos.readUInt16LE(0) !== 0x5a4d) malformed('missing MZ signature');
  const peOffset = dos.readUInt32LE(0x3c);
  if (peOffset < 4 || peOffset > peVersionLimits.maximumPeHeaderOffset) {
    malformed('PE header offset is out of range');
  }
  const fileHeader = await reader.exact(peOffset, 24);
  if (fileHeader.readUInt32LE(0) !== 0x00004550) malformed('missing PE signature');
  const sectionCount = fileHeader.readUInt16LE(6);
  const optionalSize = fileHeader.readUInt16LE(20);
  if (sectionCount === 0 || sectionCount > peVersionLimits.maximumSections) {
    malformed('section count is out of range');
  }
  if (optionalSize > peVersionLimits.maximumOptionalHeaderBytes) {
    malformed('optional header is too large');
  }
  const optionalOffset = peOffset + 24;
  const tables = await reader.exact(optionalOffset, optionalSize + sectionCount * 40);
  if (optionalSize < 2) malformed('optional header is truncated');
  const magic = tables.readUInt16LE(0);
  let directoryCountOffset: number;
  if (magic === 0x10b) directoryCountOffset = 92;
  else if (magic === 0x20b) directoryCountOffset = 108;
  else malformed('unknown optional header magic');
  const resourceDirectoryOffset = directoryCountOffset + 4 + 2 * 8;
  if (optionalSize < resourceDirectoryOffset + 8) return null;
  if (tables.readUInt32LE(directoryCountOffset) < 3) return null;
  const resourceRva = tables.readUInt32LE(resourceDirectoryOffset);
  const resourceSize = tables.readUInt32LE(resourceDirectoryOffset + 4);
  if (resourceRva === 0 || resourceSize === 0) return null;

  const sections: Section[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const base = optionalSize + index * 40;
    const virtualSize = tables.readUInt32LE(base + 8);
    const virtualAddress = tables.readUInt32LE(base + 12);
    const rawSize = tables.readUInt32LE(base + 16);
    const rawOffset = tables.readUInt32LE(base + 20);
    const mappedRawSize = virtualSize === 0 ? rawSize : Math.min(rawSize, virtualSize);
    sections.push({ virtualAddress, rawSize: mappedRawSize, rawOffset });
  }
  return { resourceRva, sections };
}

function fileOffset(layout: ImageLayout, rva: number, length: number, fileSize: number): number {
  for (const section of layout.sections) {
    const delta = rva - section.virtualAddress;
    if (delta < 0 || delta >= section.rawSize) continue;
    if (delta + length > section.rawSize) malformed('resource data crosses its section');
    const offset = section.rawOffset + delta;
    if (offset + length > fileSize) malformed('resource data is outside the file');
    return offset;
  }
  return malformed('resource address is not backed by a section');
}

interface DirectoryEntry {
  id: number | null;
  target: number;
  isDirectory: boolean;
}

async function readDirectory(
  reader: BudgetedReader,
  layout: ImageLayout,
  relativeOffset: number,
): Promise<DirectoryEntry[]> {
  const rva = layout.resourceRva + relativeOffset;
  const header = await reader.exact(fileOffset(layout, rva, 16, reader.size), 16);
  const count = header.readUInt16LE(12) + header.readUInt16LE(14);
  if (count > peVersionLimits.maximumDirectoryEntries) malformed('too many resource entries');
  const named = header.readUInt16LE(12);
  const table = await reader.exact(fileOffset(layout, rva + 16, count * 8, reader.size), count * 8);
  const entries: DirectoryEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = table.readUInt32LE(index * 8);
    const target = table.readUInt32LE(index * 8 + 4);
    const isNamed = index < named || (name & 0x80000000) !== 0;
    entries.push({
      id: isNamed ? null : name & 0xffff,
      target: target & 0x7fffffff,
      isDirectory: (target & 0x80000000) !== 0,
    });
  }
  return entries;
}

async function readVersionResource(
  reader: BudgetedReader,
  layout: ImageLayout,
): Promise<Buffer | null> {
  const types = await readDirectory(reader, layout, 0);
  const versionType = types.find((entry) => entry.id === resourceTypeVersion);
  if (!versionType) return null;
  if (!versionType.isDirectory) malformed('RT_VERSION is not a directory');
  const names = await readDirectory(reader, layout, versionType.target);
  const name = names.find((entry) => entry.id === preferredVersionResourceId) ?? names[0];
  if (!name) return null;
  if (!name.isDirectory) malformed('version resource name is not a directory');
  const languages = await readDirectory(reader, layout, name.target);
  const language = languages[0];
  if (!language) return null;
  if (language.isDirectory) malformed('version resource language is not a data entry');
  const entryRva = layout.resourceRva + language.target;
  const entry = await reader.exact(fileOffset(layout, entryRva, 16, reader.size), 16);
  const dataRva = entry.readUInt32LE(0);
  const declaredSize = entry.readUInt32LE(4);
  if (declaredSize < 6) malformed('version resource is too small');
  const size = Math.min(declaredSize, peVersionLimits.maximumVersionResourceBytes);
  return reader.exact(fileOffset(layout, dataRva, size, reader.size), size);
}

interface VersionNode {
  key: string;
  text: string | null;
  value: Buffer;
  children: VersionNode[];
}

const align4 = (offset: number) => (offset + 3) & ~3;

function parseVersionTree(bytes: Buffer): VersionNode {
  let nodes = 0;
  const parse = (start: number, limit: number, depth: number): VersionNode => {
    if (depth > peVersionLimits.maximumVersionDepth) malformed('version resource is too deep');
    nodes += 1;
    if (nodes > peVersionLimits.maximumVersionNodes)
      malformed('version resource has too many nodes');
    if (start + 6 > limit) malformed('version node header is truncated');
    const length = bytes.readUInt16LE(start);
    const valueLength = bytes.readUInt16LE(start + 2);
    const type = bytes.readUInt16LE(start + 4);
    const end = start + length;
    if (length < 6 || end > limit) malformed('version node length is out of range');
    let cursor = start + 6;
    const keyStart = cursor;
    while (cursor + 2 <= end && bytes.readUInt16LE(cursor) !== 0) cursor += 2;
    if (cursor + 2 > end) malformed('version node key is unterminated');
    const key = bytes.toString('utf16le', keyStart, cursor);
    cursor = align4(cursor + 2);
    const valueBytes = type === 1 ? valueLength * 2 : valueLength;
    const valueStart = Math.min(cursor, end);
    const valueEnd = Math.min(valueStart + valueBytes, end);
    const value = bytes.subarray(valueStart, valueEnd);
    let text: string | null = null;
    if (type === 1 && valueLength > 0) {
      let terminator = valueStart;
      while (terminator + 2 <= end && bytes.readUInt16LE(terminator) !== 0) terminator += 2;
      text = bytes.toString('utf16le', valueStart, terminator);
    }
    const children: VersionNode[] = [];
    let child = text === null ? align4(valueStart + valueBytes) : end;
    while (child + 6 <= end) {
      const childLength = bytes.readUInt16LE(child);
      if (childLength === 0) break;
      const node = parse(child, end, depth + 1);
      children.push(node);
      child = align4(child + childLength);
    }
    return { key, text, value, children };
  };
  const root = parse(0, bytes.byteLength, 0);
  if (root.key !== 'VS_VERSION_INFO') malformed('missing VS_VERSION_INFO');
  return root;
}

const sameKey = (left: string, right: string) =>
  left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');

function child(node: VersionNode | undefined, key: string): VersionNode | undefined {
  return node?.children.find((candidate) => sameKey(candidate.key, key));
}

function firstTranslation(root: VersionNode): string {
  const translation = child(child(root, 'VarFileInfo'), 'Translation');
  if (!translation || translation.value.byteLength < 4) return defaultTranslation;
  const language = translation.value.readUInt16LE(0);
  const codePage = translation.value.readUInt16LE(2);
  const hex = (value: number) => value.toString(16).toUpperCase().padStart(4, '0');
  return hex(language) + hex(codePage);
}

function selectProductVersion(root: VersionNode): string {
  const strings = child(root, 'StringFileInfo');
  const first = firstTranslation(root);
  const candidates = [first, ...fallbackTranslations.filter((candidate) => candidate !== first)];
  let productVersion = '';
  for (const candidate of candidates) {
    const table = child(strings, candidate);
    productVersion = child(table, 'ProductVersion')?.text ?? '';
    if (child(table, 'FileVersion')?.text) break;
  }
  return productVersion;
}

export async function productVersionFromSource(source: PeByteSource): Promise<string | null> {
  const reader = new BudgetedReader(source);
  try {
    const layout = await readLayout(reader);
    if (!layout) return null;
    const resource = await readVersionResource(reader, layout);
    if (!resource) return null;
    const value = selectProductVersion(parseVersionTree(resource)).trim();
    return value && value.length <= peVersionLimits.maximumProductVersionLength ? value : null;
  } catch (error) {
    if (error instanceof MalformedPe) return null;
    throw error;
  }
}

export async function readExecutableProductVersion(path: string): Promise<string | null> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return null;
    return await productVersionFromSource({
      size: metadata.size,
      async read(offset, length) {
        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return buffer.subarray(0, filled);
      },
    });
  } finally {
    await handle.close();
  }
}
