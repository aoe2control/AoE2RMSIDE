export interface PreviewTerrainCacheParts {
  map: string;
  backend: string;
  minimapPalette: string;
  terrainColors: string;
  colourLayer: { textureColors: string } | 'minimap-colors';
  connections: boolean;
  elevationMode: string;
  heightOverlayColor: number;
  raised: boolean;
}

export function previewTerrainCacheKeys(parts: PreviewTerrainCacheParts): {
  key: string;
  sceneKey: string;
} {
  const compose = (colourLayer: string) =>
    [
      parts.map,
      parts.backend,
      parts.minimapPalette,
      parts.terrainColors,
      colourLayer,
      parts.connections ? 'post-connections' : 'pre-connections',
      parts.elevationMode,
      parts.heightOverlayColor,
      parts.raised ? 'raised' : 'flat',
    ].join(':');
  const colourLayer =
    parts.colourLayer === 'minimap-colors'
      ? 'minimap-colors'
      : `texture-colors:${parts.colourLayer.textureColors}`;
  return { key: compose(colourLayer), sceneKey: compose('*') };
}
