import type { ContentPackDescriptor, ObjectClassDescriptor } from './api';

export const maximumObjectClassId = 0xffff;

export function isObjectClassList(classes: readonly number[], objectCount: number): boolean {
  return (
    classes.length === 0 ||
    (classes.length === objectCount &&
      classes.every(
        (classId) => Number.isInteger(classId) && classId >= 0 && classId <= maximumObjectClassId,
      ))
  );
}

export function objectClassDescriptors(
  pack: Pick<ContentPackDescriptor, 'objectNames' | 'objectClassIds'>,
): ObjectClassDescriptor[] {
  const classes = pack.objectClassIds ?? [];
  if (classes.length === 0 || !isObjectClassList(classes, pack.objectNames.length)) return [];
  return pack.objectNames.map((entry, index) => ({
    objectId: entry.objectId,
    classId: classes[index]!,
  }));
}

export function objectClassesFor(
  pack: Pick<ContentPackDescriptor, 'objectNames' | 'objectClassIds'>,
): { objectClasses?: ObjectClassDescriptor[] } {
  const objectClasses = objectClassDescriptors(pack);
  return objectClasses.length > 0 ? { objectClasses } : {};
}
