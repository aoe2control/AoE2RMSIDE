import {
  AlphaFilter,
  BufferImageSource,
  Rectangle,
  RenderTarget,
  RenderTexture,
  Sprite,
  type Application,
  type Container,
  type TextureSource,
} from 'pixi.js';
import { prefersReducedMotion } from './motion';
import type { ElevationSurface } from './preview-elevation';
import { HeightMorphMesh, litMorphTexels } from './preview-height-morph';
import type { MorphPicture } from './preview-morph-field';
import { TerrainMorphMesh } from './preview-morph-mesh';
import type { MorphFieldReply, MorphFieldRequest } from './preview-morph-worker';
import type { RaisedTerrainUniforms } from './preview-raised-terrain';
import { requestPreviewRender, type PreviewRenderScheduler } from './preview-render-scheduler';
import {
  MapTransitionTimeline,
  mapTransitionDurations,
  morphFieldWaitMilliseconds,
  objectsFadeAlpha,
  planMapTransition,
  smoothstep,
  type MapTransitionContext,
  type MapTransitionKind,
  type MapTransitionPlan,
  type TimelineFrame,
  type TransitionPicture,
} from './preview-transitions';

export interface MapTransitionsEnvironment {
  host: HTMLElement;
  application(): Application | null;
  scheduler(): PreviewRenderScheduler | null;
  mapLayer(): Container | null;
  now?(): number;
  reducedMotion?(): boolean;
  createWorker?(): Worker | null;
}

interface MorphState {
  track: MorphTrack;
  mesh: TerrainMorphMesh | HeightMorphMesh | null;
  target: Container;
  owned: TextureSource[];
  requestId: number;
  deferred: DeferredMorphState | null;
}

interface DeferredMorphState {
  request: DeferredMorphRequest;
  read: boolean;
  stale: boolean;
  moving: boolean;
  retired: RetiredTerrain | null;
  oldReleased: boolean;
  incomingVisible: boolean;
}

export interface RetiredTerrain {
  container: Container;
  dispose(): void;
}

interface FlattenState {
  retired: Container;
  uniforms: RaisedTerrainUniforms;
  incoming: Container;
  dispose(): void;
}

export interface MorphTerrainPicture {
  source: TextureSource;
  texels: Uint8Array;
  width: number;
  height: number;
}

export interface MorphTerrainData {
  texels: Uint8Array;
  width: number;
  height: number;
  surface: ElevationSurface | null;
}

export type MorphTrack = 'morph' | 'stage-morph';

export interface DeferredMorphRequest {
  track: MorphTrack;
  heights: boolean;
  place(mesh: Container): void;
  incoming: Container;
  incomingUniforms: RaisedTerrainUniforms | null;
  objects: Container | null;
  objectsFadeIn: boolean;
  retired: RetiredTerrain | null;
  keepsOldTerrain?: boolean;
  onOldTerrainReleased?(): void;
  pictures(): { previous: MorphTerrainData; next: MorphTerrainData } | null;
}

function defaultMorphWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./preview-morph-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function morphTexelSource(texels: Uint8Array, width: number, height: number): BufferImageSource {
  return new BufferImageSource({
    resource: texels,
    width,
    height,
    format: 'rgba8unorm',
    scaleMode: 'nearest',
    addressMode: 'clamp-to-edge',
    autoGenerateMipmaps: false,
  });
}

export class PreviewMapTransitions {
  private enabledSetting = true;
  private readonly timeline = new MapTransitionTimeline();
  private readonly now: () => number;
  private readonly reducedMotion: () => boolean;
  private readonly snapshots: ({ texture: RenderTexture; target: RenderTarget } | null)[] = [
    null,
    null,
  ];
  private capture: { index: number; renders: number } | null = null;
  private fadedCapture: { index: number; renders: number } | null = null;
  private overlay: Sprite | null = null;
  private overlayIndex = -1;
  private readonly morphs = new Map<MorphTrack, MorphState>();
  private riseState: { uniforms: RaisedTerrainUniforms; node: Container } | null = null;
  private flattenState: FlattenState | null = null;
  private objectFade: {
    filter: AlphaFilter;
    track: string;
    duration: number;
    layer: Container | null;
  } | null = null;
  private fadedLayer: Container | null = null;
  private ticking = false;
  private worker: Worker | null | undefined = undefined;
  private requestId = 0;
  private started = 0;
  private skipped = 0;
  private interrupted = 0;
  private destroyed = false;
  private readonly interrupt = () => {
    if (this.timeline.active) {
      this.interrupted += 1;
      this.finish();
    }
  };

  constructor(private readonly environment: MapTransitionsEnvironment) {
    this.now = environment.now ?? (() => performance.now());
    this.reducedMotion = environment.reducedMotion ?? prefersReducedMotion;
    for (const type of ['pointerdown', 'wheel', 'keydown'] as const) {
      environment.host.addEventListener(type, this.interrupt, { capture: true, passive: true });
    }
    this.writeDataset();
  }

  set enabled(enabled: boolean) {
    if (this.enabledSetting === enabled) return;
    this.enabledSetting = enabled;
    if (!enabled) this.finish();
    this.writeDataset();
  }

  get enabled(): boolean {
    return this.enabledSetting;
  }

  get allowed(): boolean {
    return this.enabledSetting && !this.reducedMotion() && !this.destroyed;
  }

  get reducedMotionPreferred(): boolean {
    return this.reducedMotion();
  }

  get running(): boolean {
    return this.timeline.active;
  }

  get kinds(): MapTransitionKind[] {
    return this.timeline.kinds();
  }

  plan(
    previous: TransitionPicture | null,
    next: TransitionPicture,
    context: Omit<MapTransitionContext, 'enabled' | 'reducedMotion' | 'transitionRunning'> = {},
  ): MapTransitionPlan {
    const plan = planMapTransition(previous, next, {
      ...context,
      enabled: this.enabledSetting,
      reducedMotion: this.reducedMotion(),
      transitionRunning: this.timeline.active,
    });
    if (plan.skipped) this.countSkipped();
    return plan;
  }

  countSkip(plan: MapTransitionPlan): void {
    if (plan.skipped) this.countSkipped();
  }

  liveStageAllowed(): boolean {
    if (this.allowed) return true;
    this.countSkipped();
    return false;
  }

  captureOutgoing(): boolean {
    if (!this.allowed) return false;
    const pixi = this.environment.application();
    const scheduler = this.environment.scheduler();
    if (!pixi || !scheduler || scheduler.statistics.renders === 0) return false;
    const renders = scheduler.statistics.renders;
    if (this.capture && this.capture.renders === renders) return true;
    const started = this.now();
    const index = this.overlay?.visible && this.overlayIndex === 0 ? 1 : 0;
    const { width, height } = pixi.renderer.screen;
    const resolution = pixi.renderer.resolution;
    let snapshot = this.snapshots[index];
    if (!snapshot) {
      const texture = RenderTexture.create({ width, height, resolution });
      snapshot = { texture, target: new RenderTarget({ colorTextures: [texture], depth: true }) };
      this.snapshots[index] = snapshot;
    } else if (
      snapshot.texture.width !== width ||
      snapshot.texture.height !== height ||
      snapshot.texture.source.resolution !== resolution
    ) {
      snapshot.texture.source.resize(width, height, resolution);
    }
    pixi.renderer.render({
      container: pixi.stage,
      target: snapshot.target,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
    this.capture = { index, renders };
    this.environment.host.dataset.mapTransitionCaptureMs = (this.now() - started).toFixed(2);
    return true;
  }

  crossFade(): boolean {
    const capture = this.capture;
    const pixi = this.environment.application();
    const renders = this.environment.scheduler()?.statistics.renders;
    if (!capture || capture.renders !== renders || !pixi || !this.allowed) return false;
    if (this.fadedCapture === capture && this.timeline.has('cross-fade')) return true;
    this.fadedCapture = capture;
    const snapshot = this.snapshots[capture.index]!;
    if (!this.overlay) {
      this.overlay = new Sprite({ label: 'map-transition-snapshot' });
      this.overlay.eventMode = 'none';
    }
    this.overlay.texture = snapshot.texture;
    this.overlay.position.set(0, 0);
    this.overlay.alpha = 1;
    this.overlay.visible = true;
    this.overlayIndex = capture.index;
    pixi.stage.addChild(this.overlay);
    const accompanying = this.timeline.kinds().some((kind) => kind !== 'cross-fade');
    this.begin('cross-fade', 'cross-fade', mapTransitionDurations.crossFade, null, !accompanying);
    return true;
  }

  morph(
    target: Container,
    previous: MorphTerrainPicture,
    next: MorphTerrainPicture,
    objectsFadeIn: boolean,
  ): void {
    this.endTrack('morph');
    const mesh = new TerrainMorphMesh(next.width, next.height, previous.source, next.source);
    mesh.mesh.zIndex = 1.05;
    target.sortableChildren = true;
    target.addChild(mesh.mesh);
    const requestId = (this.requestId += 1);
    this.morphs.set('morph', {
      track: 'morph',
      mesh,
      target,
      owned: [previous.source],
      requestId,
      deferred: null,
    });
    this.beginMorph('morph', false, objectsFadeIn, null);
    this.environment
      .scheduler()
      ?.addOnce(() => this.requestField(requestId, previous, next), undefined, -100);
  }

  morphLater(request: DeferredMorphRequest): void {
    this.endTrack(request.track);
    const requestId = (this.requestId += 1);
    const incomingVisible = request.incoming.visible;
    request.incoming.visible = false;
    requestPreviewRender(request.incoming);
    if (request.retired) {
      request.retired.container.visible = true;
      request.retired.container.renderable = true;
    }
    this.morphs.set(request.track, {
      track: request.track,
      mesh: null,
      target: request.incoming,
      owned: [],
      requestId,
      deferred: {
        request,
        read: false,
        stale: false,
        moving: false,
        retired: request.retired,
        oldReleased: false,
        incomingVisible,
      },
    });
    this.beginMorph(request.track, request.heights, request.objectsFadeIn, request.objects);
    const scheduler = this.environment.scheduler();
    scheduler?.addOnce(
      () =>
        scheduler.addOnce(
          () => scheduler.addOnce(() => this.buildDeferred(requestId)),
          undefined,
          -100,
        ),
      undefined,
      -100,
    );
  }

  rise(uniforms: RaisedTerrainUniforms, node: Container, objectsFadeIn: boolean): void {
    this.endTrack('rise');
    uniforms.setLift(0);
    this.riseState = { uniforms, node };
    this.begin('rise', 'rise', mapTransitionDurations.rise);
    if (objectsFadeIn) this.fadeObjects('rise', mapTransitionDurations.rise, null);
  }

  flatten(state: FlattenState): void {
    this.endTrack('flatten');
    state.incoming.alpha = 0;
    this.flattenState = state;
    this.begin('flatten', 'flatten', mapTransitionDurations.flatten);
  }

  keeps(child: Container): boolean {
    if (child === this.overlay || child === this.flattenState?.retired) return true;
    for (const state of this.morphs.values()) {
      if (state.deferred?.retired?.container === child) return true;
    }
    return false;
  }

  retire(retired: RetiredTerrain): boolean {
    for (const state of this.morphs.values()) {
      const deferred = state.deferred;
      if (
        !deferred?.request.keepsOldTerrain ||
        deferred.moving ||
        deferred.oldReleased ||
        deferred.retired
      ) {
        continue;
      }
      deferred.retired = retired;
      retired.container.visible = true;
      retired.container.renderable = true;
      return true;
    }
    return false;
  }

  placeStageNodes(stage: Container, terrain: Container): void {
    if (terrain.parent === stage) {
      const retired = this.flattenState?.retired;
      if (retired && !retired.destroyed) {
        retired.position.copyFrom(terrain.position);
        retired.scale.copyFrom(terrain.scale);
        stage.addChildAt(retired, stage.getChildIndex(terrain));
      }
      for (const state of this.morphs.values()) {
        const kept = state.deferred?.retired?.container;
        if (kept && !kept.destroyed) stage.addChildAt(kept, stage.getChildIndex(terrain));
      }
    }
    if (this.overlay && this.timeline.has('cross-fade')) stage.addChild(this.overlay);
  }

  get stageMorphRunning(): boolean {
    return this.morphs.has('stage-morph');
  }

  stageChanged(): void {
    const deferred = this.morphs.get('stage-morph')?.deferred;
    if (deferred?.read) deferred.stale = true;
  }

  finishStageMorph(): void {
    this.endTrack('stage-morph');
    this.writeDataset();
  }

  finishTerrain(): void {
    for (const id of ['morph', 'rise', 'flatten']) this.endTrack(id);
    this.writeDataset();
  }

  finish(): void {
    if (!this.timeline.active && this.morphs.size === 0 && !this.flattenState) return;
    for (const frame of this.timeline.finish()) this.apply(frame);
    for (const track of [...this.morphs.keys()]) {
      this.apply({ id: track, kind: 'morph', progress: 1, eased: 1, ended: true });
    }
    this.writeDataset();
    const scheduler = this.environment.scheduler();
    scheduler?.request();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.finish();
    this.destroyed = true;
    for (const type of ['pointerdown', 'wheel', 'keydown'] as const) {
      this.environment.host.removeEventListener(type, this.interrupt, { capture: true });
    }
    this.overlay?.destroy();
    this.overlay = null;
    for (const snapshot of this.snapshots) {
      snapshot?.target.destroy();
      snapshot?.texture.destroy(true);
    }
    this.snapshots.fill(null);
    this.capture = null;
    this.worker?.terminate();
    this.worker = null;
    for (const key of [
      'mapTransition',
      'mapTransitionCount',
      'mapTransitionLast',
      'mapTransitionSkipped',
      'mapTransitionInterrupted',
      'mapTransitions',
      'mapTransitionMorph',
      'mapTransitionMorphSource',
    ]) {
      delete this.environment.host.dataset[key];
    }
  }

  private countSkipped(): void {
    this.skipped += 1;
    this.writeDataset();
  }

  private begin(
    id: string,
    kind: MapTransitionKind,
    duration: number,
    hold: { holdMilliseconds: number } | null = null,
    counted = true,
  ): void {
    this.timeline.start(id, kind, this.now(), duration, hold);
    if (counted) {
      this.started += 1;
      this.environment.host.dataset.mapTransitionLast = kind;
    }
    this.writeDataset();
    this.tick();
  }

  private beginMorph(
    track: MorphTrack,
    heights: boolean,
    objectsFadeIn: boolean,
    objects: Container | null,
  ): void {
    const host = this.environment.host;
    host.dataset.mapTransitionMorph = heights ? 'heights' : 'flat';
    host.dataset.mapTransitionMorphSource = track === 'stage-morph' ? 'live-stage' : 'map';
    host.dataset.morphField = 'pending';
    delete host.dataset.morphFieldMs;
    this.begin(track, 'morph', mapTransitionDurations.morph, {
      holdMilliseconds: morphFieldWaitMilliseconds,
    });
    if (objectsFadeIn) this.fadeObjects(track, mapTransitionDurations.morph, objects);
  }

  private tick(): void {
    if (this.ticking || this.destroyed) return;
    const scheduler = this.environment.scheduler();
    if (!scheduler) return;
    this.ticking = true;
    scheduler.addOnce(() => {
      this.ticking = false;
      if (this.destroyed) return;
      for (const frame of this.timeline.advance(this.now())) this.apply(frame, true);
      if (this.timeline.active) this.tick();
      this.writeDataset();
    });
  }

  private apply(frame: TimelineFrame, natural = false): void {
    switch (frame.id) {
      case 'cross-fade': {
        const overlay = this.overlay;
        if (!overlay) break;
        overlay.alpha = 1 - frame.eased;
        if (frame.ended) {
          overlay.visible = false;
          overlay.removeFromParent();
        }
        requestPreviewRender(overlay.parent ?? this.environment.application()?.stage);
        break;
      }
      case 'morph':
      case 'stage-morph':
        this.applyMorph(frame, natural);
        break;
      case 'rise': {
        const state = this.riseState;
        if (!state) break;
        state.uniforms.setLift(frame.eased);
        if (!state.node.destroyed) requestPreviewRender(state.node);
        if (frame.ended) this.riseState = null;
        break;
      }
      case 'flatten': {
        const state = this.flattenState;
        if (!state) break;
        state.uniforms.setLift(1 - frame.eased);
        if (!state.incoming.destroyed) {
          state.incoming.alpha = smoothstep(0.2, 1, frame.eased);
          requestPreviewRender(state.incoming);
        }
        if (frame.ended) {
          this.flattenState = null;
          if (!state.incoming.destroyed) state.incoming.alpha = 1;
          state.dispose();
        }
        break;
      }
    }
    const fade = this.objectFade;
    if (fade && fade.track === frame.id) {
      this.fadeMapLayer(frame.ended ? 1 : objectsFadeAlpha(frame.eased, fade.duration));
      if (frame.ended) {
        this.fadeMapLayer(null);
        this.objectFade = null;
      }
    }
  }

  private applyMorph(frame: TimelineFrame, natural: boolean): void {
    const state = this.morphs.get(frame.id as MorphTrack);
    if (!state) return;
    const deferred = state.deferred;
    if (deferred && !frame.ended && frame.progress > 0 && !deferred.moving) {
      if (!state.mesh) {
        this.endTrack(state.track);
        return;
      }
      deferred.moving = true;
      state.mesh.mesh.visible = true;
      this.releaseOldTerrain(deferred);
    }
    state.mesh?.setProgress(frame.eased);
    if (!state.target.destroyed) requestPreviewRender(state.target);
    if (!frame.ended) return;
    const fading = natural && deferred?.stale === true && this.captureOutgoing();
    this.morphs.delete(state.track);
    state.mesh?.destroy();
    for (const source of state.owned) source.destroy();
    if (deferred) {
      this.releaseOldTerrain(deferred);
      const incoming = deferred.request.incoming;
      if (!incoming.destroyed) {
        incoming.visible = deferred.incomingVisible;
        requestPreviewRender(incoming);
      }
    }
    if (!state.target.destroyed) requestPreviewRender(state.target);
    if (this.morphs.size === 0) delete this.environment.host.dataset.morphField;
    if (fading) this.crossFade();
  }

  private releaseOldTerrain(deferred: DeferredMorphState): void {
    if (deferred.oldReleased) return;
    deferred.oldReleased = true;
    const retired = deferred.retired;
    deferred.retired = null;
    retired?.dispose();
    deferred.request.onOldTerrainReleased?.();
  }

  private endTrack(id: string): void {
    const frame = this.timeline.end(id);
    if (frame) this.apply(frame);
  }

  private buildDeferred(requestId: number): void {
    const state = [...this.morphs.values()].find((entry) => entry.requestId === requestId);
    const deferred = state?.deferred;
    if (!state || !deferred || this.destroyed) return;
    const request = deferred.request;
    const pictures = request.pictures();
    deferred.read = true;
    if (!pictures || request.incoming.destroyed) {
      this.endTrack(state.track);
      this.writeDataset();
      this.environment.scheduler()?.request();
      return;
    }
    const { previous, next } = pictures;
    let mesh: TerrainMorphMesh | HeightMorphMesh;
    if (request.heights && next.surface && request.incomingUniforms) {
      mesh = new HeightMorphMesh(
        {
          colours: litMorphTexels(previous.texels, previous.surface),
          width: previous.width,
          height: previous.height,
          surface: previous.surface,
        },
        {
          colours: litMorphTexels(next.texels, next.surface),
          width: next.width,
          height: next.height,
          surface: next.surface,
        },
        request.incomingUniforms,
      );
    } else {
      const previousSource = morphTexelSource(
        litMorphTexels(previous.texels, previous.surface),
        previous.width,
        previous.height,
      );
      const nextSource = morphTexelSource(next.texels, next.width, next.height);
      state.owned.push(previousSource, nextSource);
      mesh = new TerrainMorphMesh(next.width, next.height, previousSource, nextSource);
    }
    mesh.mesh.visible = false;
    state.mesh = mesh;
    request.place(mesh.mesh);
    this.requestField(requestId, previous, next);
  }

  private fadeObjects(track: string, duration: number, layer: Container | null): void {
    if (this.objectFade) {
      this.fadeMapLayer(null);
      this.objectFade = null;
    }
    this.objectFade = { filter: new AlphaFilter({ alpha: 0 }), track, duration, layer };
    this.fadeMapLayer(0);
  }

  private fadeMapLayer(alpha: number | null): void {
    const fade = this.objectFade;
    const layer = fade?.layer ?? this.environment.mapLayer();
    const previous = this.fadedLayer;
    if (previous && (previous !== layer || alpha === null)) {
      if (!previous.destroyed) {
        if (fade?.layer === previous) previous.alpha = 1;
        else previous.filters = null;
        requestPreviewRender(previous);
      }
      this.fadedLayer = null;
    }
    if (alpha === null || !fade || !layer || layer.destroyed) {
      if (alpha === null) fade?.filter.destroy();
      return;
    }
    if (fade.layer) {
      layer.alpha = alpha;
      this.fadedLayer = layer;
      requestPreviewRender(layer);
      return;
    }
    fade.filter.alpha = alpha;
    const pixi = this.environment.application();
    if (pixi) {
      const { width, height } = pixi.renderer.screen;
      const scale = layer.scale.x || 1;
      layer.filterArea = new Rectangle(
        -layer.position.x / scale,
        -layer.position.y / scale,
        width / scale,
        height / scale,
      );
    }
    if (this.fadedLayer !== layer) {
      layer.filters = [fade.filter];
      this.fadedLayer = layer;
    }
    requestPreviewRender(layer);
  }

  private requestField(requestId: number, previous: MorphPicture, next: MorphPicture): void {
    const state = [...this.morphs.values()].find((entry) => entry.requestId === requestId);
    if (!state || !state.mesh) return;
    if (this.worker === undefined) {
      this.worker = (this.environment.createWorker ?? defaultMorphWorker)();
      this.worker?.addEventListener('message', (event: MessageEvent<MorphFieldReply>) =>
        this.receiveField(event.data),
      );
    }
    const worker = this.worker;
    if (!worker) {
      this.environment.host.dataset.morphField = 'none';
      this.timeline.release(state.track, this.now());
      this.tick();
      return;
    }
    const previousTexels = previous.texels.slice();
    const nextTexels = next.texels.slice();
    const request: MorphFieldRequest = {
      id: requestId,
      previous: { texels: previousTexels, width: previous.width, height: previous.height },
      next: { texels: nextTexels, width: next.width, height: next.height },
    };
    worker.postMessage(request, [previousTexels.buffer, nextTexels.buffer]);
  }

  private receiveField(reply: MorphFieldReply): void {
    const state = [...this.morphs.values()].find((entry) => entry.requestId === reply.id);
    if (!state || !this.timeline.has(state.track)) return;
    const host = this.environment.host;
    if (!this.timeline.held(state.track)) {
      host.dataset.morphField = 'late';
      return;
    }
    state.mesh?.setField(reply.texels, reply.size, reply.maximum);
    host.dataset.morphField = 'ready';
    host.dataset.morphFieldMs = reply.milliseconds.toFixed(1);
    host.dataset.morphMovedBlocks = String(reply.movedBlocks);
    this.timeline.release(state.track, this.now());
    this.tick();
  }

  private writeDataset(): void {
    if (this.destroyed) return;
    const host = this.environment.host;
    const kinds = this.timeline.kinds();
    if (kinds.length > 0) host.dataset.mapTransition = kinds.join(' ');
    else delete host.dataset.mapTransition;
    host.dataset.mapTransitions = !this.enabledSetting
      ? 'off'
      : this.reducedMotion()
        ? 'reduced-motion'
        : 'on';
    host.dataset.mapTransitionCount = String(this.started);
    host.dataset.mapTransitionSkipped = String(this.skipped);
    host.dataset.mapTransitionInterrupted = String(this.interrupted);
  }
}

export function morphPicture(
  source: BufferImageSource | null,
  width: number,
  height: number,
): MorphTerrainPicture | null {
  const texels = source?.resource;
  if (!source || !(texels instanceof Uint8Array) || texels.length !== width * height * 4) {
    return null;
  }
  return { source, texels, width, height };
}
