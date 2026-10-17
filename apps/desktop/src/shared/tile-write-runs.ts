export const maximumTileWriteRuns = 524_288;
export const tileWriteRunBytes = 12;

export function validTileWriteRuns(
  bytes: Uint8Array,
  tileCount: number,
  operationCount: number,
): boolean {
  if (bytes.byteLength % tileWriteRunBytes !== 0) return false;
  const count = bytes.byteLength / tileWriteRunBytes;
  if (count > maximumTileWriteRuns) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let previousOperation = -1;
  let previousEnd = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += tileWriteRunBytes) {
    const operation = view.getUint32(offset, true);
    const first = view.getUint32(offset + 4, true);
    const length = view.getUint32(offset + 8, true);
    if (operation >= operationCount || length === 0 || first + length > tileCount) return false;
    if (operation < previousOperation) return false;
    if (operation === previousOperation && first <= previousEnd) return false;
    previousOperation = operation;
    previousEnd = first + length;
  }
  return true;
}

export function forEachWrittenTile(
  bytes: Uint8Array,
  operations: ReadonlySet<number>,
  visit: (tileIndex: number) => void,
): void {
  if (operations.size === 0) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (
    let offset = 0;
    offset + tileWriteRunBytes <= bytes.byteLength;
    offset += tileWriteRunBytes
  ) {
    if (!operations.has(view.getUint32(offset, true))) continue;
    const first = view.getUint32(offset + 4, true);
    const end = first + view.getUint32(offset + 8, true);
    for (let tile = first; tile < end; tile += 1) visit(tile);
  }
}
