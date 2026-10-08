export const appearanceObjectRecordBytes = 16;
export const maximumAppearanceObjects = 524_288;

export interface TerrainAppearanceRecord {
  objectId: number;
  x: number;
  y: number;
  footprint: number;
  tree: boolean;
}

export function decodeAppearanceObjectColumn(
  bytes: Uint8Array,
  width: number,
  height: number,
): TerrainAppearanceRecord[] | null {
  if (
    bytes.byteLength % appearanceObjectRecordBytes !== 0 ||
    bytes.byteLength / appearanceObjectRecordBytes > maximumAppearanceObjects
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: TerrainAppearanceRecord[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += appearanceObjectRecordBytes) {
    const x256 = view.getUint32(offset + 4, true);
    const y256 = view.getUint32(offset + 8, true);
    const kind = view.getUint8(offset + 14);
    if (x256 >= width * 256 || y256 >= height * 256 || kind > 1 || view.getUint8(offset + 15)) {
      return null;
    }
    records.push({
      objectId: view.getUint32(offset, true),
      x: x256 / 256,
      y: y256 / 256,
      footprint: view.getUint16(offset + 12, true) / 256,
      tree: kind === 0,
    });
  }
  return records;
}
