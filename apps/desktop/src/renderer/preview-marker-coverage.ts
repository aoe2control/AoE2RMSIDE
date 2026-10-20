import {
  previewScreenTransform,
  type PreviewCamera,
  type PreviewViewport,
} from './top-down-preview';

export const markerCoverageReach = 32;

export interface MarkerCoverageArea {
  camera: PreviewCamera;
  margin: { x: number; y: number };
}

export function markerAreaCovers(
  area: MarkerCoverageArea,
  scene: { width: number; height: number },
  viewport: PreviewViewport,
  camera: PreviewCamera,
  reach = markerCoverageReach,
): boolean {
  const transform = previewScreenTransform(
    scene.width,
    scene.height,
    area.camera,
    viewport,
    camera,
    viewport,
  );
  const left = -area.margin.x * transform.scale + transform.x;
  const top = -area.margin.y * transform.scale + transform.y;
  const right = (viewport.width + area.margin.x) * transform.scale + transform.x;
  const bottom = (viewport.height + area.margin.y) * transform.scale + transform.y;
  return (
    left <= -reach &&
    top <= -reach &&
    right >= viewport.width + reach &&
    bottom >= viewport.height + reach
  );
}

export class MarkerCoverage {
  readonly drawn: Uint8Array;
  private readonly areas: MarkerCoverageArea[] = [];
  private everything: boolean;

  constructor(
    readonly scene: { width: number; height: number },
    readonly viewport: PreviewViewport,
    objectCount: number,
  ) {
    this.drawn = new Uint8Array(objectCount);
    this.everything = false;
  }

  add(area: MarkerCoverageArea, culled: boolean): void {
    this.areas.push(area);
    if (!culled) this.everything = true;
  }

  get parts(): number {
    return this.areas.length;
  }

  covers(camera: PreviewCamera): boolean {
    if (this.everything) return true;
    for (let index = this.areas.length - 1; index >= 0; index -= 1) {
      if (markerAreaCovers(this.areas[index]!, this.scene, this.viewport, camera)) return true;
    }
    return false;
  }
}
