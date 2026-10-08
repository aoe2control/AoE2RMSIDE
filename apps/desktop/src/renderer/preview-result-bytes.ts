import type { PreviewGenerationResult } from '../shared/api';
import { connectionRoutesBytes } from '../shared/connection-routes';

export function previewResultBytes(result: PreviewGenerationResult): number {
  return (
    result.playerColorIds.length * 8 +
    result.objectNames.reduce((bytes, entry) => bytes + 8 + entry.name.length * 2, 0) +
    result.terrainNames.reduce((bytes, entry) => bytes + 8 + entry.name.length * 2, 0) +
    [...(result.constantNames?.objects ?? []), ...(result.constantNames?.terrains ?? [])].reduce(
      (bytes, entry) => bytes + 8 + entry.name.length * 2,
      0,
    ) +
    result.terrainIdsLe.byteLength +
    result.preConnectionTerrainIdsLe.byteLength +
    result.elevations.byteLength +
    result.terrainZonesLe.byteLength +
    result.landIdsLe.byteLength +
    result.cliffEdges.byteLength +
    (result.cliffPiecesLe?.byteLength ?? 0) +
    (result.appearanceObjectsLe?.byteLength ?? 0) +
    result.layerIdsLe.byteLength +
    result.flagsLe.byteLength +
    result.objects.idsLe.byteLength +
    result.objects.xLe.byteLength +
    result.objects.yLe.byteLength +
    result.objects.owners.byteLength +
    result.objects.facetsLe.byteLength +
    result.objects.footprintWidths256Le.byteLength +
    result.objects.footprintHeights256Le.byteLength +
    result.objects.presentationKinds.byteLength +
    result.objects.resourceTypeLe.byteLength +
    result.objects.resourceQuantityF32BitsLe.byteLength +
    result.objects.resourceDeltasLe.byteLength +
    result.objects.statusesLe.byteLength +
    result.objects.deathStates.byteLength +
    result.objects.dataStatusesLe.byteLength +
    result.objects.selectionFlags.byteLength +
    result.objects.behaviorFlagsLe.byteLength +
    result.connections.startXLe.byteLength +
    result.connections.startYLe.byteLength +
    result.connections.endXLe.byteLength +
    result.connections.endYLe.byteLength +
    result.connections.kinds.byteLength +
    connectionRoutesBytes(result.connectionRoutes) +
    result.tileSourceIndicesLe.byteLength +
    result.tileByteStartsLe.byteLength +
    result.tileByteEndsLe.byteLength +
    result.tileOperationIndicesLe.byteLength +
    result.objectOperationIndicesLe.byteLength +
    result.cliffOperationIndicesLe.byteLength +
    result.connectionOperationIndicesLe.byteLength
  );
}
