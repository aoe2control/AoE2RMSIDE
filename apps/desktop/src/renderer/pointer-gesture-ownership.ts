export const gestureFollowUpMs = 400;

const guardedEvents = [
  'mousedown',
  'pointerup',
  'mouseup',
  'click',
  'auxclick',
  'dblclick',
  'contextmenu',
] as const;

const cancelledEvents = new Set<string>([
  'mousedown',
  'click',
  'auxclick',
  'dblclick',
  'contextmenu',
]);

export interface GestureInput {
  readonly type: string;
  readonly surface: string | null;
  readonly buttons: number;
  readonly time: number;
  readonly key?: string;
}

type GestureState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'held'; readonly owner: string }
  | { readonly phase: 'released'; readonly owner: string; readonly until: number };

export class PointerGestureOwnership {
  private state: GestureState = { phase: 'idle' };

  constructor(private readonly followUpMs = gestureFollowUpMs) {}

  get owner(): string | null {
    return this.state.phase === 'idle' ? null : this.state.owner;
  }

  get releasing(): boolean {
    return this.state.phase === 'released';
  }

  observe(input: GestureInput): boolean {
    if (this.state.phase === 'released' && input.time >= this.state.until) {
      this.state = { phase: 'idle' };
    }
    switch (input.type) {
      case 'pointerdown':
        this.state = input.surface ? { phase: 'held', owner: input.surface } : { phase: 'idle' };
        return false;
      case 'pointermove':
        if (this.state.phase === 'held' && input.buttons === 0) this.state = { phase: 'idle' };
        return false;
      case 'pointerup':
      case 'mouseup': {
        const stop = this.aimedElsewhere(input.surface);
        if (this.state.phase === 'held' && input.buttons === 0) {
          this.state = {
            phase: 'released',
            owner: this.state.owner,
            until: input.time + this.followUpMs,
          };
        }
        return stop;
      }
      case 'mousedown':
      case 'click':
      case 'auxclick':
      case 'dblclick':
      case 'contextmenu':
        return this.aimedElsewhere(input.surface);
      case 'pointercancel':
      case 'blur':
        this.state = { phase: 'idle' };
        return false;
      case 'keydown':
        if (input.key === 'Escape' && this.state.phase === 'released') {
          this.state = { phase: 'idle' };
        }
        return false;
      default:
        return false;
    }
  }

  private aimedElsewhere(surface: string | null): boolean {
    return this.state.phase !== 'idle' && surface !== null && surface !== this.state.owner;
  }
}

export function pointerSurfaceOf(target: EventTarget | null): string | null {
  const node = target as Partial<Element & Node> | null;
  const element =
    typeof node?.closest === 'function' ? (node as Element) : (node?.parentElement ?? null);
  const surface = element?.closest('[data-pointer-surface]');
  return surface?.getAttribute('data-pointer-surface') ?? null;
}

export function guardPointerGestureEvent(
  ownership: PointerGestureOwnership,
  event: Event,
  target: EventTarget,
): boolean {
  if (event.type === 'blur' && event.target !== target) return false;
  const fields = event as Partial<MouseEvent & KeyboardEvent>;
  const stop = ownership.observe({
    type: event.type,
    surface: pointerSurfaceOf(event.target),
    buttons: typeof fields.buttons === 'number' ? fields.buttons : 0,
    time: event.timeStamp,
    ...(typeof fields.key === 'string' ? { key: fields.key } : {}),
  });
  if (!stop) return false;
  event.stopPropagation();
  if (cancelledEvents.has(event.type)) event.preventDefault();
  return true;
}

export const pointerGestureEventTypes: readonly string[] = [
  'pointerdown',
  ...guardedEvents,
  'pointermove',
  'pointercancel',
  'keydown',
  'blur',
];

export function installPointerGestureOwnership(target: Window = window): () => void {
  const ownership = new PointerGestureOwnership();
  const guard = (event: Event) => {
    if (event.isTrusted) guardPointerGestureEvent(ownership, event, target);
  };
  for (const type of pointerGestureEventTypes) target.addEventListener(type, guard, true);
  return () => {
    for (const type of pointerGestureEventTypes) target.removeEventListener(type, guard, true);
  };
}
