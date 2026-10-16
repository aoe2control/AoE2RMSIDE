import type { WorkspaceUnsavedText } from '../shared/api';

export function sameUnsavedTexts(
  left: readonly WorkspaceUnsavedText[],
  right: readonly WorkspaceUnsavedText[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((document, index) => {
    const other = right[index]!;
    return document.path === other.path && document.content === other.content;
  });
}
