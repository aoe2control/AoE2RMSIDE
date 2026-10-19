import type { TopDownObject } from './top-down-preview';

export type PreviewObjectCategory =
  | 'building'
  | 'farm'
  | 'wall'
  | 'unit'
  | 'animal'
  | 'mine'
  | 'forage'
  | 'tree'
  | 'special'
  | 'unknown';

export const nativeObjectClassCategories: ReadonlyMap<number, PreviewObjectCategory> = new Map<
  number,
  PreviewObjectCategory
>([
  [3, 'building'],
  [39, 'building'],
  [52, 'building'],
  [60, 'building'],
  [49, 'farm'],
  [27, 'wall'],
  ...[
    0, 2, 4, 6, 12, 13, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28, 35, 36, 37, 43, 44, 45, 46, 47,
    50, 51, 53, 54, 55, 56, 57, 59,
  ].map((classId) => [classId, 'unit'] as const),
  ...[9, 10, 29, 38, 58, 61, 65].map((classId) => [classId, 'animal'] as const),
  ...[8, 32, 48].map((classId) => [classId, 'mine'] as const),
  ...[7, 5, 31, 33, 63].map((classId) => [classId, 'forage'] as const),
  [15, 'tree'],
  ...[1, 30, 42].map((classId) => [classId, 'special'] as const),
]);

const resourceTypes = Object.freeze({ food: 0, wood: 1, stone: 2, gold: 3 });

export type PreviewCategoryObject = Pick<TopDownObject, 'presentationKind'> &
  Partial<
    Pick<
      TopDownObject,
      'objectClass' | 'resourceType' | 'footprintWidth' | 'footprintHeight' | 'appearance'
    >
  >;

export function previewObjectCategory(object: PreviewCategoryObject): PreviewObjectCategory {
  if (object.presentationKind === 'wall') return 'wall';
  if (object.appearance === 'tree') return 'tree';
  if (object.objectClass !== undefined) {
    return nativeObjectClassCategories.get(object.objectClass) ?? 'unknown';
  }
  if (object.appearance === 'decoration') return 'unknown';
  const side = Math.min(object.footprintWidth ?? 0, object.footprintHeight ?? 0);
  const footprint = Number.isFinite(side) ? side : 0;
  switch (object.resourceType) {
    case resourceTypes.wood:
      return 'tree';
    case resourceTypes.stone:
    case resourceTypes.gold:
      return 'mine';
    case resourceTypes.food:
      return footprint >= 2 ? 'farm' : footprint >= 1 ? 'forage' : 'animal';
    default:
      return footprint >= 1 ? 'building' : 'unknown';
  }
}
