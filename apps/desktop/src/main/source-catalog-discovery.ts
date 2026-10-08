import type { MainSourceCatalog } from './source-catalog-service';

export type DiscoveredIncludeKind = 'rms' | 'xs';
export interface DiscoveredInclude {
  path: string;
  kind: DiscoveredIncludeKind;
}
export interface SourceDiscoveryScan {
  sourceId: string;
  source: Uint8Array;
  profileId: string;
  implicitDefinitions: Readonly<Record<string, string>>;
}
export interface SourceDiscoveryLookup {
  sourcePath: string;
  requests: readonly DiscoveredInclude[];
  roots: MainSourceCatalog['roots'];
  caseSensitive: boolean;
  namespaceEvidence: readonly { path: string; present: boolean }[];
}
export type SourceDiscoveryLookupResult =
  | { namespacePaths: readonly string[] }
  | {
      standardIncludes: readonly string[];
      plans: readonly (DiscoveredInclude & {
        paths: readonly string[];
        blocked?: 'standard-include-unavailable';
      })[];
    };
export interface SourceCatalogDiscovery {
  scan(input: SourceDiscoveryScan): Promise<readonly DiscoveredInclude[]>;
  lookup(input: SourceDiscoveryLookup): Promise<SourceDiscoveryLookupResult>;
}

const version = Object.freeze({ major: 1, minor: 0, patch: 0 });
const maximumMetadataBytes = 2 * 1024 * 1024;

export function nativeSourceCatalogDiscovery(
  request: (params: unknown) => Promise<unknown>,
): SourceCatalogDiscovery {
  return {
    async scan(input) {
      if (input.source.byteLength > 4 * 1024 * 1024)
        throw new Error('source discovery exceeds the 4 MiB file bound');
      const result = reply(
        await request({
          contractVersion: version,
          operation: 'scan',
          sourceId: input.sourceId,
          sourceBase64: Buffer.from(input.source).toString('base64'),
          profileId: input.profileId,
          implicitDefinitions: input.implicitDefinitions,
        }),
      );
      return list(result.requests).map(include);
    },
    async lookup(input) {
      const result = reply(
        await request({ contractVersion: version, operation: 'lookup', ...input }),
      );
      if ('namespacePaths' in result) return { namespacePaths: paths(result.namespacePaths) };
      const plans = list(result.plans).map((value) => {
        const candidate = object(value);
        const request = include(value);
        const blocked = candidate.blocked;
        if (blocked !== undefined && blocked !== 'standard-include-unavailable')
          throw new Error('source discovery returned an invalid refusal');
        const locations = paths(candidate.paths);
        if (blocked && locations.length !== 0)
          throw new Error('source discovery refused a request with probe authority');
        return {
          ...request,
          paths: locations,
          ...(blocked ? { blocked: blocked as 'standard-include-unavailable' } : {}),
        };
      });
      if (
        plans.length !== input.requests.length ||
        plans.some(
          (plan, index) =>
            plan.path !== input.requests[index]!.path || plan.kind !== input.requests[index]!.kind,
        )
      ) {
        throw new Error('source discovery changed or omitted a lookup request');
      }
      return { standardIncludes: paths(result.standardIncludes), plans };
    },
  };
}

function reply(value: unknown): Record<string, unknown> {
  const result = object(value);
  const contract = object(result.contractVersion);
  if (contract.major !== 1 || contract.minor !== 0 || contract.patch !== 0)
    throw new Error('source discovery returned an unsupported contract');
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maximumMetadataBytes)
    throw new Error('source discovery response exceeds its metadata bound');
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('source discovery returned an invalid object');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 4096)
    throw new Error('source discovery returned an invalid bounded list');
  return value;
}
function path(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 16_384 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('source discovery returned an invalid relative path');
  }
  return value;
}
function paths(value: unknown): string[] {
  return list(value).map(path);
}
function include(value: unknown): DiscoveredInclude {
  const candidate = object(value);
  if (candidate.kind !== 'rms' && candidate.kind !== 'xs')
    throw new Error('source discovery returned an invalid include kind');
  return { path: path(candidate.path), kind: candidate.kind };
}
