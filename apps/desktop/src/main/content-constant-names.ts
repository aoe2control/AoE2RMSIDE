import type { ContentPackDescriptor, RmsConstantNames } from '../shared/api';
import { definitionCandidates, shippedNameKinds } from './definition-file-service';

export function contentConstantNames(contentPack: ContentPackDescriptor): RmsConstantNames | null {
  if (cache.has(contentPack)) return cache.get(contentPack)!;
  const names = computeConstantNames(contentPack);
  cache.set(contentPack, names);
  return names;
}

export function constantNamesField(contentPack: ContentPackDescriptor): {
  constantNames?: RmsConstantNames;
} {
  const constantNames = contentConstantNames(contentPack);
  return constantNames ? { constantNames } : {};
}

const cache = new WeakMap<ContentPackDescriptor, RmsConstantNames | null>();

function computeConstantNames(contentPack: ContentPackDescriptor): RmsConstantNames | null {
  if (contentPack.synthetic || !contentPack.packagedBundle) return null;
  const kinds = shippedNameKinds(contentPack);
  if (!kinds) return null;
  const { builtIn } = definitionCandidates({
    implicitDefinitions: contentPack.implicitDefinitions,
    objectIds: new Set(contentPack.objectNames.map((entry) => entry.objectId)),
    kindOf: (name) => kinds.get(name) ?? null,
    displayNames: null,
  });
  return {
    objects: preferredConstants(builtIn.objects).map(([objectId, name]) => ({ objectId, name })),
    terrains: preferredConstants(builtIn.terrains).map(([terrainId, name]) => ({
      terrainId,
      name,
    })),
  };
}

function preferredConstants(
  entries: readonly { id: number; name: string }[],
): Array<[number, string]> {
  const preferred = new Map<number, string>();
  for (const { id, name } of entries) {
    const current = preferred.get(id);
    if (current === undefined || preferredConstant(name, current)) preferred.set(id, name);
  }
  return [...preferred.entries()].sort(([left], [right]) => left - right);
}

function preferredConstant(candidate: string, current: string): boolean {
  if (candidate.length !== current.length) return candidate.length < current.length;
  return candidate < current;
}
