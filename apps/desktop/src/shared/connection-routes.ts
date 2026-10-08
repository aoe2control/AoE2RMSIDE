export const connectionRoutesFormatMajor = 1;
export const maximumConnectionRouteRecords = 2_048;
export const maximumConnectionRouteBytes = 2 * 1024 * 1024;
export const connectionRouteRecordBytes = 16;
export const connectionRouteVertexBytes = 4;
export const failedConnectionSearch = 0xffff_ffff;

export const connectionRouteOmission = Object.freeze({
  attemptRetention: 1,
  presentationBudget: 2,
  frameBudget: 4,
});

export interface PreviewConnectionRoutes {
  state: 'available';
  formatMinor: number;
  totalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  retainedAttempts: number;
  retainedSuccessfulAttempts: number;
  omissionReasons: number;
  recordsLe: Uint8Array;
  verticesLe: Uint8Array;
}

export interface InvalidPreviewConnectionRoutes {
  state: 'invalid';
}

export type PreviewConnectionRoutesPayload =
  PreviewConnectionRoutes | InvalidPreviewConnectionRoutes;

export interface ConnectionRouteContext {
  width: number;
  height: number;
  connections: {
    startXLe: Uint8Array;
    startYLe: Uint8Array;
    endXLe: Uint8Array;
    endYLe: Uint8Array;
    kinds: Uint8Array;
  };
  connectionOperationIndicesLe: Uint8Array;
  operationCount: number;
}

export interface ConnectionRouteSet {
  records: Uint32Array;
  vertices: Uint16Array;
  count: number;
  totalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  retainedAttempts: number;
  omissionReasons: number;
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateConnectionRoutes(
  routes: Omit<PreviewConnectionRoutes, 'state' | 'formatMinor'>,
  context: ConnectionRouteContext,
): ConnectionRouteSet | string {
  const {
    totalAttempts,
    successfulAttempts,
    failedAttempts,
    retainedAttempts,
    retainedSuccessfulAttempts,
    omissionReasons,
    recordsLe,
    verticesLe,
  } = routes;
  const { width, height } = context;
  const tileCount = width * height;
  if (!Number.isSafeInteger(tileCount) || tileCount < 1) return 'map dimensions are invalid';
  if (
    ![
      totalAttempts,
      successfulAttempts,
      failedAttempts,
      retainedAttempts,
      retainedSuccessfulAttempts,
      omissionReasons,
    ].every(isCount) ||
    successfulAttempts + failedAttempts !== totalAttempts ||
    retainedAttempts > totalAttempts ||
    retainedAttempts > maximumConnectionRouteRecords ||
    retainedSuccessfulAttempts > retainedAttempts ||
    retainedSuccessfulAttempts > successfulAttempts ||
    retainedAttempts - retainedSuccessfulAttempts > failedAttempts
  ) {
    return 'route counts are inconsistent';
  }
  if (
    recordsLe.byteLength % connectionRouteRecordBytes !== 0 ||
    verticesLe.byteLength % connectionRouteVertexBytes !== 0 ||
    recordsLe.byteLength + verticesLe.byteLength > maximumConnectionRouteBytes
  ) {
    return 'route columns have an invalid length';
  }
  const count = recordsLe.byteLength / connectionRouteRecordBytes;
  const vertexCount = verticesLe.byteLength / connectionRouteVertexBytes;
  if (count > retainedAttempts) return 'more routes than kept searches';
  const retention = totalAttempts > retainedAttempts;
  if (retention !== ((omissionReasons & connectionRouteOmission.attemptRetention) !== 0)) {
    return 'the attempt retention reason does not match the counts';
  }
  const trimmed = count < retainedAttempts;
  const trimReasons =
    omissionReasons &
    (connectionRouteOmission.presentationBudget | connectionRouteOmission.frameBudget);
  if (trimmed !== (trimReasons !== 0)) {
    return 'the omission reasons do not match the presented routes';
  }
  const connectionCount = context.connections.kinds.byteLength;
  if (context.connectionOperationIndicesLe.byteLength !== connectionCount * 4) {
    return 'connection provenance does not match the connection graph';
  }
  const graph = {
    startX: new DataView(
      context.connections.startXLe.buffer,
      context.connections.startXLe.byteOffset,
      context.connections.startXLe.byteLength,
    ),
    startY: new DataView(
      context.connections.startYLe.buffer,
      context.connections.startYLe.byteOffset,
      context.connections.startYLe.byteLength,
    ),
    endX: new DataView(
      context.connections.endXLe.buffer,
      context.connections.endXLe.byteOffset,
      context.connections.endXLe.byteLength,
    ),
    endY: new DataView(
      context.connections.endYLe.buffer,
      context.connections.endYLe.byteOffset,
      context.connections.endYLe.byteLength,
    ),
    operations: new DataView(
      context.connectionOperationIndicesLe.buffer,
      context.connectionOperationIndicesLe.byteOffset,
      context.connectionOperationIndicesLe.byteLength,
    ),
  };
  if (
    [graph.startX, graph.startY, graph.endX, graph.endY].some(
      (column) => column.byteLength !== connectionCount * 2,
    )
  ) {
    return 'connection columns have an invalid length';
  }
  const recordView = new DataView(recordsLe.buffer, recordsLe.byteOffset, recordsLe.byteLength);
  const vertexView = new DataView(verticesLe.buffer, verticesLe.byteOffset, verticesLe.byteLength);
  const records = new Uint32Array(count * 4);
  const vertices = new Uint16Array(vertexCount * 2);
  for (let index = 0; index < vertexCount; index += 1) {
    const x = vertexView.getUint16(index * 4, true);
    const y = vertexView.getUint16(index * 4 + 2, true);
    if (x >= width || y >= height) return 'a route vertex lies outside the map';
    vertices[index * 2] = x;
    vertices[index * 2 + 1] = y;
  }
  let nextVertex = 0;
  let nextGraphIndex = 0;
  let failures = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = index * connectionRouteRecordBytes;
    const graphIndex = recordView.getUint32(offset, true);
    const operationIndex = recordView.getUint32(offset + 4, true);
    const firstVertex = recordView.getUint32(offset + 8, true);
    const vertexTotal = recordView.getUint32(offset + 12, true);
    if (firstVertex !== nextVertex || vertexTotal === 0 || vertexTotal > tileCount) {
      return 'route vertices are not contiguous';
    }
    if (firstVertex + vertexTotal > vertexCount) {
      return 'route vertices exceed the vertex column';
    }
    if (operationIndex >= context.operationCount) {
      return 'a route names an unknown provenance operation';
    }
    if (graphIndex === failedConnectionSearch) {
      if (vertexTotal !== 2) return 'a failed search does not have two endpoints';
      failures += 1;
    } else {
      if (graphIndex !== nextGraphIndex) {
        return 'successful routes are not in connection graph order';
      }
      if (graphIndex >= connectionCount) return 'a route names an unknown connection';
      const last = firstVertex + vertexTotal - 1;
      if (
        graph.operations.getUint32(graphIndex * 4, true) !== operationIndex ||
        vertices[firstVertex * 2] !== graph.startX.getUint16(graphIndex * 2, true) ||
        vertices[firstVertex * 2 + 1] !== graph.startY.getUint16(graphIndex * 2, true) ||
        vertices[last * 2] !== graph.endX.getUint16(graphIndex * 2, true) ||
        vertices[last * 2 + 1] !== graph.endY.getUint16(graphIndex * 2, true)
      ) {
        return 'a route does not match its connection';
      }
      for (let vertex = firstVertex + 1; vertex <= last; vertex += 1) {
        const dx = Math.abs(vertices[vertex * 2]! - vertices[(vertex - 1) * 2]!);
        const dy = Math.abs(vertices[vertex * 2 + 1]! - vertices[(vertex - 1) * 2 + 1]!);
        if (Math.max(dx, dy) !== 1) return 'a route step is not to an adjacent tile';
      }
      nextGraphIndex += 1;
    }
    records[index * 4] = graphIndex;
    records[index * 4 + 1] = operationIndex;
    records[index * 4 + 2] = firstVertex;
    records[index * 4 + 3] = vertexTotal;
    nextVertex = firstVertex + vertexTotal;
  }
  if (nextVertex !== vertexCount) return 'unreferenced route vertices remain';
  if (
    nextGraphIndex > retainedSuccessfulAttempts ||
    failures > retainedAttempts - retainedSuccessfulAttempts
  ) {
    return 'presented routes exceed the kept searches';
  }
  return {
    records,
    vertices,
    count,
    totalAttempts,
    successfulAttempts,
    failedAttempts,
    retainedAttempts,
    omissionReasons,
  };
}

export function decodeConnectionRoutes(
  map: Pick<
    ConnectionRouteContext,
    'width' | 'height' | 'connections' | 'connectionOperationIndicesLe'
  > & {
    connectionRoutes?: PreviewConnectionRoutesPayload;
    provenanceOperations: readonly unknown[];
  },
): ConnectionRouteSet | null {
  const routes = map.connectionRoutes;
  if (!routes || routes.state !== 'available') return null;
  const decoded = validateConnectionRoutes(routes, {
    width: map.width,
    height: map.height,
    connections: map.connections,
    connectionOperationIndicesLe: map.connectionOperationIndicesLe,
    operationCount: map.provenanceOperations.length,
  });
  return typeof decoded === 'string' ? null : decoded;
}

export function connectionRoutesBytes(routes: PreviewConnectionRoutesPayload | undefined): number {
  return routes?.state === 'available'
    ? routes.recordsLe.byteLength + routes.verticesLe.byteLength
    : 0;
}
