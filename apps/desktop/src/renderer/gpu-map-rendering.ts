import {
  gpuTerrainBlendFragment,
  gpuTerrainBlendVertex,
  gpuTerrainPlainFragment,
  gpuTerrainPlainVertex,
} from './game-art-gpu-terrain';
import { playerColorSpriteFragment, playerColorSpriteVertex } from './game-art-sprites';

export type MapRenderer = 'gpu' | 'cpu';

export type GpuMapUnavailableReason =
  'webgl2-missing' | 'software-renderer' | 'shader-unsupported' | 'context-lost' | 'layer-failed';

export function chooseMapRenderer(
  preference: boolean,
  unavailable: GpuMapUnavailableReason | null,
): MapRenderer {
  return preference && unavailable === null ? 'gpu' : 'cpu';
}

export function gpuMapRenderingMessageCode(reason: GpuMapUnavailableReason): string {
  if (reason === 'context-lost') return 'preview.gpu-map-rendering-lost';
  if (reason === 'software-renderer') return 'preview.gpu-map-rendering-software';
  return 'preview.gpu-map-rendering-unavailable';
}

const softwareRendererPatterns: readonly RegExp[] = [
  /swiftshader/iu,
  /basic render driver/iu,
  /\bwarp\b/iu,
  /llvmpipe/iu,
  /softpipe/iu,
  /lavapipe/iu,
  /\bsoftware\b/iu,
];

export function isSoftwareRendererName(name: string): boolean {
  return softwareRendererPatterns.some((pattern) => pattern.test(name));
}

const unmaskedRendererParameter = 0x9246;

export function webglRendererNames(gl: ProbeContext): string[] {
  const names: string[] = [];
  const read = (parameter: number) => {
    try {
      const value: unknown = gl.getParameter(parameter);
      if (typeof value === 'string' && value.length > 0) names.push(value);
    } catch {}
  };
  if (gl.getExtension('WEBGL_debug_renderer_info')) read(unmaskedRendererParameter);
  read(gl.RENDERER);
  return names;
}

export function webglHasMajorPerformanceCaveat(): boolean {
  if (typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
  if (!context) return true;
  context.getExtension('WEBGL_lose_context')?.loseContext();
  return false;
}

export const gpuMapRenderingPrograms: readonly { vertex: string; fragment: string }[] = [
  { vertex: gpuTerrainPlainVertex, fragment: gpuTerrainPlainFragment },
  { vertex: gpuTerrainBlendVertex, fragment: gpuTerrainBlendFragment },
  { vertex: playerColorSpriteVertex, fragment: playerColorSpriteFragment },
];

export type ProbeContext = Pick<
  WebGL2RenderingContext,
  | 'createShader'
  | 'shaderSource'
  | 'compileShader'
  | 'getShaderParameter'
  | 'deleteShader'
  | 'createProgram'
  | 'attachShader'
  | 'linkProgram'
  | 'getProgramParameter'
  | 'deleteProgram'
  | 'isContextLost'
  | 'getExtension'
  | 'getParameter'
  | 'RENDERER'
  | 'VERTEX_SHADER'
  | 'FRAGMENT_SHADER'
  | 'COMPILE_STATUS'
  | 'LINK_STATUS'
>;

export function probeGpuMapRendering(
  renderer: {
    type?: number;
    gl?: unknown;
    context?: { webGLVersion?: number };
  },
  hasMajorPerformanceCaveat: () => boolean = webglHasMajorPerformanceCaveat,
): GpuMapUnavailableReason | null {
  const gl = renderer.gl as ProbeContext | undefined;
  if (!gl || renderer.context?.webGLVersion !== 2) return 'webgl2-missing';
  if (gl.isContextLost()) return 'context-lost';
  if (webglRendererNames(gl).some(isSoftwareRendererName) || hasMajorPerformanceCaveat()) {
    return 'software-renderer';
  }
  return compileGpuMapPrograms(gl) ? null : 'shader-unsupported';
}

export function lazyGpuMapProbe<TRenderer extends object>(
  probe: (renderer: TRenderer) => GpuMapUnavailableReason | null,
): (renderer: TRenderer) => GpuMapUnavailableReason | null {
  let probed: { renderer: TRenderer; reason: GpuMapUnavailableReason | null } | null = null;
  return (renderer) => {
    if (probed?.renderer !== renderer) probed = { renderer, reason: probe(renderer) };
    return probed.reason;
  };
}

export function compileGpuMapPrograms(gl: ProbeContext): boolean {
  for (const program of gpuMapRenderingPrograms) {
    const vertex = gl.createShader(gl.VERTEX_SHADER);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    const linked = gl.createProgram();
    try {
      if (!vertex || !fragment || !linked) return false;
      gl.shaderSource(vertex, program.vertex);
      gl.shaderSource(fragment, program.fragment);
      gl.compileShader(vertex);
      gl.compileShader(fragment);
      if (
        !gl.getShaderParameter(vertex, gl.COMPILE_STATUS) ||
        !gl.getShaderParameter(fragment, gl.COMPILE_STATUS)
      ) {
        return false;
      }
      gl.attachShader(linked, vertex);
      gl.attachShader(linked, fragment);
      gl.linkProgram(linked);
      if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) return false;
    } finally {
      if (linked) gl.deleteProgram(linked);
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }
  }
  return true;
}

export function watchGpuContextLoss(
  canvas: Pick<HTMLCanvasElement, 'addEventListener' | 'removeEventListener'>,
  onLost: () => void,
): () => void {
  const listener = () => onLost();
  canvas.addEventListener('webglcontextlost', listener);
  return () => canvas.removeEventListener('webglcontextlost', listener);
}
