export const smallTreeScale = 0.5;

export function treeSpriteScale(smallTrees: boolean): number {
  return smallTrees ? smallTreeScale : 1;
}

export function spritePartPlacement(
  anchorX: number,
  anchorY: number,
  offsetX: number,
  offsetY: number,
  unitsPerPixelX: number,
  unitsPerPixelY: number,
  factor: number,
): { x: number; y: number; scaleX: number; scaleY: number } {
  return {
    x: anchorX + offsetX * unitsPerPixelX * factor,
    y: anchorY + offsetY * unitsPerPixelY * factor,
    scaleX: unitsPerPixelX * factor,
    scaleY: unitsPerPixelY * factor,
  };
}
