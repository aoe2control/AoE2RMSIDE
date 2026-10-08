import type { ContentPackDescriptor, MapIconArtKind, MapIconArtObjectDescriptor } from './api';

export const mapIconArtMaximumConstants = 16;

export function mapIconArtObjectDescriptors(
  pack: Pick<
    ContentPackDescriptor,
    'implicitDefinitions' | 'treeObjectIds' | 'goldObjectIds' | 'stoneObjectIds'
  >,
): MapIconArtObjectDescriptor[] {
  const kinds = new Map<number, MapIconArtKind>();
  for (const [kind, ids] of [
    ['gold', pack.goldObjectIds],
    ['stone', pack.stoneObjectIds],
    ['tree', pack.treeObjectIds],
  ] as const) {
    for (const id of ids ?? []) if (!kinds.has(id)) kinds.set(id, kind);
  }
  if (kinds.size === 0) return [];
  const constants = new Map<number, string[]>();
  for (const name of Object.keys(pack.implicitDefinitions).sort()) {
    const value = pack.implicitDefinitions[name]!;
    if (!/^\d{1,9}$/u.test(value)) continue;
    const id = Number(value);
    if (kinds.get(id) !== 'tree') continue;
    const list = constants.get(id) ?? [];
    if (list.length < mapIconArtMaximumConstants) list.push(name);
    constants.set(id, list);
  }
  return [...kinds.entries()]
    .sort(([left], [right]) => left - right)
    .map(([objectId, kind]) => ({ objectId, kind, constants: constants.get(objectId) ?? [] }));
}

export function isAscendingObjectIdList(ids: readonly number[], limit: number): boolean {
  return (
    ids.length <= limit &&
    ids.every(
      (id, index) =>
        Number.isInteger(id) &&
        id >= 0 &&
        id <= 0xffff_ffff &&
        (index === 0 || ids[index - 1]! < id),
    )
  );
}
