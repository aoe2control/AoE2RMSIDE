export const sizeTransitionProperties: ReadonlySet<string> = new Set([
  'flex-basis',
  'grid-template-columns',
  'grid-template-rows',
  'height',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'width',
]);

export const sizeTransitionStaleMs = 1_000;

export class SizeTransitionTracker<Target> {
  readonly #running = new Map<Target, Map<string, number>>();

  get active(): boolean {
    return this.#running.size > 0;
  }

  run(target: Target, property: string): boolean {
    if (!sizeTransitionProperties.has(property)) return false;
    let properties = this.#running.get(target);
    if (!properties) {
      properties = new Map();
      this.#running.set(target, properties);
    }
    properties.set(property, (properties.get(property) ?? 0) + 1);
    return true;
  }

  finish(target: Target, property: string): boolean {
    const properties = this.#running.get(target);
    const count = properties?.get(property);
    if (!properties || count === undefined) return false;
    if (count > 1) properties.set(property, count - 1);
    else properties.delete(property);
    if (properties.size === 0) this.#running.delete(target);
    return true;
  }

  clear(): void {
    this.#running.clear();
  }
}

export interface SizeTransitionEvent {
  readonly propertyName: string;
  readonly target: unknown;
}

export interface SizeTransitionEnvironment {
  addEventListener(type: string, listener: (event: SizeTransitionEvent) => void): void;
  removeEventListener(type: string, listener: (event: SizeTransitionEvent) => void): void;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: number): void;
}

export interface SizeTransitionWatch {
  readonly active: boolean;
  dispose(): void;
}

const transitionStartEvents = ['transitionrun'] as const;
const transitionEndEvents = ['transitionend', 'transitioncancel'] as const;

export function watchSizeTransitions(
  affects: (target: unknown) => boolean,
  handlers: { onStart(): void; onSettle(): void },
  environment: SizeTransitionEnvironment,
): SizeTransitionWatch {
  const tracker = new SizeTransitionTracker<unknown>();
  let active = false;
  let settleFrame: number | null = null;
  let staleTimer: number | null = null;
  let disposed = false;

  const cancelSettle = () => {
    if (settleFrame !== null) environment.cancelFrame(settleFrame);
    settleFrame = null;
  };
  const cancelStale = () => {
    if (staleTimer !== null) environment.clearTimeout(staleTimer);
    staleTimer = null;
  };
  const settle = () => {
    settleFrame = null;
    if (disposed || tracker.active || !active) return;
    cancelStale();
    active = false;
    handlers.onSettle();
  };
  const armStale = () => {
    cancelStale();
    staleTimer = environment.setTimeout(() => {
      staleTimer = null;
      tracker.clear();
      cancelSettle();
      settle();
    }, sizeTransitionStaleMs);
  };
  const started = (event: SizeTransitionEvent) => {
    if (disposed || !affects(event.target)) return;
    if (!tracker.run(event.target, event.propertyName)) return;
    cancelSettle();
    armStale();
    if (active) return;
    active = true;
    handlers.onStart();
  };
  const ended = (event: SizeTransitionEvent) => {
    if (disposed || !tracker.finish(event.target, event.propertyName)) return;
    armStale();
    if (!tracker.active && settleFrame === null) settleFrame = environment.requestFrame(settle);
  };
  for (const type of transitionStartEvents) environment.addEventListener(type, started);
  for (const type of transitionEndEvents) environment.addEventListener(type, ended);
  return {
    get active() {
      return active;
    },
    dispose() {
      disposed = true;
      cancelSettle();
      cancelStale();
      for (const type of transitionStartEvents) environment.removeEventListener(type, started);
      for (const type of transitionEndEvents) environment.removeEventListener(type, ended);
    },
  };
}

export function documentTransitionEnvironment(document: Document): SizeTransitionEnvironment {
  const view: Window = document.defaultView ?? window;
  return {
    addEventListener: (type, listener) =>
      document.addEventListener(type, listener as unknown as EventListener, true),
    removeEventListener: (type, listener) =>
      document.removeEventListener(type, listener as unknown as EventListener, true),
    requestFrame: (callback) => view.requestAnimationFrame(callback),
    cancelFrame: (handle) => view.cancelAnimationFrame(handle),
    setTimeout: (callback, milliseconds) => view.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => view.clearTimeout(handle),
  };
}
