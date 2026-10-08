import type {
  LocalDisplayStringStatus,
  LocalPresentationName,
  LocalPresentationNames,
  TerrainMinimapColor,
} from './api';

export const localPresentationNameLimits = Object.freeze({
  maximumObjectId: 65_535,
  maximumTerrainId: 255,
  maximumNameLength: 128,
  maximumDisplayNameLength: 128,
  maximumAliases: 16,
});

const constantPattern = /^[\x21-\x7e]+$/u;
const displayStatuses = new Set<LocalDisplayStringStatus>([
  'available',
  'unsupported-dat-layout',
  'unavailable',
]);

export function validateLocalPresentationNames(value: unknown): LocalPresentationNames | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError('local presentation names are invalid');
  const version = value.contractVersion;
  if (!isRecord(version) || version.major !== 1 || version.minor !== 2 || version.patch !== 0) {
    throw new TypeError('local presentation names contract is unsupported');
  }
  const productVersion = value.productVersion;
  if (
    productVersion !== null &&
    (typeof productVersion !== 'string' ||
      productVersion.length < 1 ||
      productVersion.length > 64 ||
      !/^[\x20-\x7e]+$/u.test(productVersion))
  ) {
    throw new TypeError('local presentation product version is invalid');
  }
  if (typeof value.productVersionVerified !== 'boolean') {
    throw new TypeError('local presentation verification is invalid');
  }
  if (
    typeof value.displayStrings !== 'string' ||
    !displayStatuses.has(value.displayStrings as LocalDisplayStringStatus)
  ) {
    throw new TypeError('local presentation display-string status is invalid');
  }
  const extraKeys = Object.keys(value).filter(
    (key) =>
      ![
        'contractVersion',
        'productVersion',
        'productVersionVerified',
        'displayStrings',
        'objects',
        'terrains',
        'graphiclessObjectIds',
        'terrainColors',
      ].includes(key),
  );
  if (extraKeys.length > 0) throw new TypeError('local presentation names carry unknown fields');
  return Object.freeze({
    contractVersion: Object.freeze({ major: 1, minor: 2, patch: 0 }),
    productVersion: productVersion as string | null,
    productVersionVerified: value.productVersionVerified,
    displayStrings: value.displayStrings as LocalDisplayStringStatus,
    objects: validateEntries(value.objects, localPresentationNameLimits.maximumObjectId),
    terrains: validateEntries(value.terrains, localPresentationNameLimits.maximumTerrainId),
    graphiclessObjectIds: validateIdentities(
      value.graphiclessObjectIds,
      localPresentationNameLimits.maximumObjectId,
    ),
    terrainColors: validateTerrainColors(value.terrainColors),
  }) as LocalPresentationNames;
}

function validateTerrainColors(value: unknown): TerrainMinimapColor[] {
  const maximumId = localPresentationNameLimits.maximumTerrainId;
  if (!Array.isArray(value) || value.length > maximumId + 1) {
    throw new TypeError('local presentation terrain colors are invalid');
  }
  let previous = -1;
  const colors = value.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 4 ||
      typeof entry.terrainId !== 'number' ||
      !Number.isInteger(entry.terrainId) ||
      entry.terrainId <= previous ||
      entry.terrainId > maximumId ||
      ![entry.highColor, entry.mediumColor, entry.lowColor].every(isRgb)
    ) {
      throw new TypeError('local presentation terrain color is invalid');
    }
    previous = entry.terrainId;
    return Object.freeze({
      terrainId: entry.terrainId,
      highColor: entry.highColor as number,
      mediumColor: entry.mediumColor as number,
      lowColor: entry.lowColor as number,
    });
  });
  return Object.freeze(colors) as TerrainMinimapColor[];
}

function isRgb(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff;
}

function validateIdentities(value: unknown, maximumId: number): number[] {
  if (!Array.isArray(value) || value.length > maximumId + 1) {
    throw new TypeError('local presentation identity list is invalid');
  }
  let previous = -1;
  for (const id of value) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= previous || id > maximumId) {
      throw new TypeError('local presentation identities must ascend within bounds');
    }
    previous = id;
  }
  return Object.freeze([...(value as number[])]) as number[];
}

function validateEntries(value: unknown, maximumId: number): LocalPresentationName[] {
  if (!Array.isArray(value) || value.length > maximumId + 1) {
    throw new TypeError('local presentation name list is invalid');
  }
  let previous = -1;
  const entries = value.map((entry: unknown) => {
    if (!isRecord(entry)) throw new TypeError('local presentation name is invalid');
    const { id, displayName, constant, aliases } = entry;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= previous || id > maximumId) {
      throw new TypeError('local presentation name identities must ascend within bounds');
    }
    previous = id;
    if (displayName !== null && !isDisplayName(displayName)) {
      throw new TypeError('local presentation display name is invalid');
    }
    if (constant !== null && !isConstant(constant)) {
      throw new TypeError('local presentation constant is invalid');
    }
    if (
      !Array.isArray(aliases) ||
      aliases.length > localPresentationNameLimits.maximumAliases ||
      !aliases.every(isConstant) ||
      (constant === null && aliases.length > 0)
    ) {
      throw new TypeError('local presentation aliases are invalid');
    }
    if (displayName === null && constant === null) {
      throw new TypeError('local presentation name is empty');
    }
    return Object.freeze({
      id,
      displayName: displayName as string | null,
      constant: constant as string | null,
      aliases: Object.freeze([...(aliases as string[])]) as string[],
    });
  });
  return Object.freeze(entries) as LocalPresentationName[];
}

export function isConstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= localPresentationNameLimits.maximumNameLength &&
    constantPattern.test(value)
  );
}

function isDisplayName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= localPresentationNameLimits.maximumDisplayNameLength &&
    value.trim() === value &&
    !/(?![‌‍])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
