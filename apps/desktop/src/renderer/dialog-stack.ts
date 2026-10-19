import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from 'react';

export type DialogKind = 'dialog' | 'confirmation';

export type DialogBackdrop = 'own' | 'pending' | 'stacked' | 'hidden' | 'released';

export type DialogCover = 'none' | 'covering' | 'covered' | 'uncovering';

export interface DialogLayer {
  readonly backdrop: DialogBackdrop;
  readonly cover: DialogCover;
  readonly reportsCover: boolean;
}

const layers = new Map<string, DialogLayer>();

function layer(backdrop: DialogBackdrop, cover: DialogCover, reportsCover = false): DialogLayer {
  const key = `${backdrop}:${cover}:${reportsCover}`;
  let value = layers.get(key);
  if (!value) {
    value = Object.freeze({ backdrop, cover, reportsCover });
    layers.set(key, value);
  }
  return value;
}

export const plainDialogLayer: DialogLayer = layer('own', 'none');

interface Entry {
  readonly id: number;
  readonly kind: DialogKind;
}

interface Release {
  readonly layer: DialogLayer;
  readonly beneath: readonly number[];
}

export interface DialogStack {
  open(kind: DialogKind): number;
  release(id: number): void;
  forget(id: number): void;
  coverComplete(id: number): void;
  layerOf(id: number): DialogLayer;
  subscribe(listener: () => void): () => void;
}

export function createDialogStack(): DialogStack {
  let nextId = 1;
  let entries: Entry[] = [];
  let effective: number | null = null;
  const uncovering = new Set<number>();
  const released = new Map<number, Release>();
  const listeners = new Set<() => void>();

  function ownerIndex(): number {
    for (let index = entries.length - 1; index > 0; index -= 1) {
      if (entries[index]!.kind === 'confirmation') return index;
    }
    return 0;
  }

  function effectiveIndex(owner: number): number {
    const index = entries.findIndex((entry) => entry.id === effective);
    return index < 0 || index > owner ? owner : index;
  }

  function stackedLayer(index: number): DialogLayer {
    const owner = ownerIndex();
    const shown = effectiveIndex(owner);
    if (index > owner) return plainDialogLayer;
    if (shown === owner) {
      if (index === owner) return owner === 0 ? plainDialogLayer : layer('stacked', 'none');
      return layer('hidden', 'covered');
    }
    if (index === owner) return layer('pending', 'none');
    if (index < shown) return layer('hidden', 'covered');
    const backdrop: DialogBackdrop =
      index === shown
        ? shown === 0
          ? 'own'
          : 'stacked'
        : entries[index]!.kind === 'confirmation'
          ? 'pending'
          : 'own';
    return layer(backdrop, 'covering', index === owner - 1);
  }

  function layerAt(index: number): DialogLayer {
    const value = stackedLayer(index);
    if (value.cover === 'none' && uncovering.has(entries[index]!.id)) {
      return layer(value.backdrop, 'uncovering', value.reportsCover);
    }
    return value;
  }

  function commit(previous: ReadonlyMap<number, DialogLayer>): void {
    if (entries.length === 0) effective = null;
    else if (!entries.some((entry) => entry.id === effective)) {
      effective = entries[ownerIndex()]!.id;
    }
    entries.forEach((entry, index) => {
      const cover = stackedLayer(index).cover;
      if (cover !== 'none') uncovering.delete(entry.id);
      else {
        const before = previous.get(entry.id)?.cover;
        if (before === 'covering' || before === 'covered') uncovering.add(entry.id);
      }
    });
    for (const listener of [...listeners]) listener();
  }

  function snapshot(): Map<number, DialogLayer> {
    return new Map(entries.map((entry, index) => [entry.id, layerAt(index)]));
  }

  return {
    open(kind) {
      const previous = snapshot();
      const id = nextId;
      nextId += 1;
      entries = [...entries, { id, kind }];
      commit(previous);
      return id;
    },
    release(id) {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      const previous = snapshot();
      released.set(id, {
        layer: layerAt(index),
        beneath: entries.slice(0, index).map((entry) => entry.id),
      });
      entries = entries.filter((entry) => entry.id !== id);
      uncovering.delete(id);
      commit(previous);
    },
    forget(id) {
      released.delete(id);
    },
    coverComplete(id) {
      const owner = ownerIndex();
      if (owner === 0 || entries[owner - 1]?.id !== id) return;
      if (effectiveIndex(owner) === owner) return;
      const previous = snapshot();
      effective = entries[owner]!.id;
      commit(previous);
    },
    layerOf(id) {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index >= 0) return layerAt(index);
      const release = released.get(id);
      if (!release) return plainDialogLayer;
      const { backdrop, cover } = release.layer;
      if (backdrop === 'pending' || backdrop === 'stacked' || backdrop === 'released') {
        const beneathStays = release.beneath.some((beneath) =>
          entries.some((entry) => entry.id === beneath),
        );
        return layer(beneathStays ? 'released' : 'own', cover);
      }
      return layer(backdrop, cover);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const stack = createDialogStack();

export function useDialogLayer(
  kind: DialogKind,
  open: boolean,
): { layer: DialogLayer; reportCoverComplete: () => void } {
  const id = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!open) return undefined;
    if (id.current !== null) stack.forget(id.current);
    const current = stack.open(kind);
    id.current = current;
    return () => stack.release(current);
  }, [kind, open]);
  useEffect(
    () => () => {
      if (id.current !== null) stack.forget(id.current);
    },
    [],
  );
  const current = useSyncExternalStore(stack.subscribe, () =>
    id.current === null ? plainDialogLayer : stack.layerOf(id.current),
  );
  const reportCoverComplete = useCallback(() => {
    if (id.current !== null) stack.coverComplete(id.current);
  }, []);
  return { layer: current, reportCoverComplete };
}

export const dialogCoverAnimation = 'dialog-cover-in';

export function useDialogCoverReport(
  popup: HTMLElement | null,
  layer: DialogLayer,
  report: () => void,
): void {
  useLayoutEffect(() => {
    if (!layer.reportsCover) return undefined;
    const running =
      popup
        ?.getAnimations()
        .some(
          (animation) =>
            'animationName' in animation && animation.animationName === dialogCoverAnimation,
        ) ?? false;
    if (!popup || !running) {
      report();
      return undefined;
    }
    const ended = (event: AnimationEvent) => {
      if (event.target === popup && event.animationName === dialogCoverAnimation) report();
    };
    popup.addEventListener('animationend', ended);
    popup.addEventListener('animationcancel', ended);
    return () => {
      popup.removeEventListener('animationend', ended);
      popup.removeEventListener('animationcancel', ended);
    };
  }, [layer.reportsCover, popup, report]);
}

interface DialogLayerValue {
  layer: DialogLayer;
  reportCoverComplete: () => void;
}

export const DialogLayerContext = createContext<DialogLayerValue>({
  layer: plainDialogLayer,
  reportCoverComplete: () => undefined,
});

export function useStackedBackdrop(): DialogBackdrop | undefined {
  const { backdrop } = useContext(DialogLayerContext).layer;
  return backdrop === 'own' ? undefined : backdrop;
}

export function useStackedPopup<T extends HTMLElement>(
  forwarded?: Ref<T>,
): { ref: (node: T | null) => void; cover: DialogCover | undefined } {
  const { layer: current, reportCoverComplete } = useContext(DialogLayerContext);
  const [popup, setPopup] = useState<T | null>(null);
  const forwardedRef = useRef(forwarded);
  forwardedRef.current = forwarded;
  const ref = useCallback((node: T | null) => {
    setPopup(node);
    const target = forwardedRef.current;
    if (typeof target === 'function') target(node);
    else if (target) target.current = node;
  }, []);
  useDialogCoverReport(popup, current, reportCoverComplete);
  return { ref, cover: current.cover === 'none' ? undefined : current.cover };
}

const coveredDismissals = new Set(['escape-key', 'outside-press', 'focus-out']);

export function refusesCoveredDismissal(layer: DialogLayer, reason: string): boolean {
  return (layer.cover === 'covering' || layer.cover === 'covered') && coveredDismissals.has(reason);
}
