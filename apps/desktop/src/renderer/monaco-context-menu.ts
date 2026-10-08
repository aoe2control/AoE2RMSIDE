export interface MonacoMenuAction {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly checked?: boolean | undefined;
  readonly actions?: readonly MonacoMenuAction[];
  run(...args: unknown[]): unknown;
}

export interface ResolvedKeybinding {
  getLabel(): string | null;
}

interface MonacoActionRunner {
  run(action: MonacoMenuAction, context?: unknown): Promise<void>;
}

type MonacoMenuAnchor =
  | HTMLElement
  | { x: number; y: number; width?: number; height?: number }
  | { posx: number; posy: number };

export interface MonacoContextMenuDelegate {
  getAnchor(): MonacoMenuAnchor;
  getActions(): readonly MonacoMenuAction[];
  getActionsContext?(event?: unknown): unknown;
  getKeyBinding?(action: MonacoMenuAction): ResolvedKeybinding | undefined;
  actionRunner?: MonacoActionRunner;
  autoSelectFirstItem?: boolean;
  onHide?(didCancel: boolean): void;
}

export interface MonacoContextMenuHandler {
  configure(options: unknown): void;
  showContextMenu(delegate: MonacoContextMenuDelegate): void;
}

export const monacoSeparatorId = 'vs.actions.separator';

export type EditorMenuEntry =
  | {
      kind: 'action';
      key: string;
      label: string;
      enabled: boolean;
      checked: boolean | undefined;
      keybinding: string | null;
      action: MonacoMenuAction;
    }
  | { kind: 'separator'; key: string }
  | { kind: 'submenu'; key: string; label: string; entries: EditorMenuEntry[] };

export interface EditorMenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
  element: boolean;
}

export interface EditorMenuRequest {
  readonly id: number;
  readonly anchor: EditorMenuAnchor;
  readonly entries: readonly EditorMenuEntry[];
  readonly focusReturn: HTMLElement | null;
  readonly chosen: () => boolean;
  close(choice: MonacoMenuAction | null): void;
}

const mnemonic = /\(&([^\s&])\)|(^|[^&])&([^\s&])/u;

export function cleanMenuLabel(label: string): string {
  const match = mnemonic.exec(label);
  if (!match) return label;
  const inText = !match[1];
  return label.replace(mnemonic, inText ? '$2$3' : '').trim();
}

export const commandPaletteActionId = 'editor.action.quickCommand';

export const pasteActionId = 'editor.action.clipboardPasteAction';

export const sourceEditorMenuActionIds: ReadonlySet<string> = new Set([
  'rmside.openIncludedFileAtCursor',
  'editor.action.revealDefinition',
  'editor.action.goToReferences',
  'editor.action.quickOutline',
  'editor.action.peekDefinition',
  'editor.action.referenceSearch.trigger',
  'editor.action.rename',
  'editor.action.changeAll',
  'editor.action.formatDocument',
  'editor.action.clipboardCutAction',
  'editor.action.clipboardCopyAction',
  pasteActionId,
  commandPaletteActionId,
]);

export const mapTestEditorMenuActionIds: ReadonlySet<string> = new Set([
  'editor.action.revealDefinition',
  'editor.action.quickOutline',
  'editor.action.peekDefinition',
  'editor.action.changeAll',
  'editor.action.formatDocument',
  'editor.action.clipboardCutAction',
  'editor.action.clipboardCopyAction',
  pasteActionId,
  commandPaletteActionId,
]);

const reviewedEditorMenuActionIds: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['rms', sourceEditorMenuActionIds],
  ['xs', sourceEditorMenuActionIds],
  ['starlark', mapTestEditorMenuActionIds],
]);

function holdsAction(actions: readonly MonacoMenuAction[], id: string): boolean {
  return actions.some(
    (action) =>
      action.id === id || (Array.isArray(action.actions) && holdsAction(action.actions, id)),
  );
}

export function editorMenuActionFilter(
  languageId: string | null,
  actions: readonly MonacoMenuAction[],
): ((action: MonacoMenuAction) => boolean) | null {
  const reviewed = languageId ? reviewedEditorMenuActionIds.get(languageId) : undefined;
  if (!reviewed) return null;
  if (!holdsAction(actions, commandPaletteActionId)) return null;
  return (action) => reviewed.has(action.id);
}

export function editorMenuEntries(
  actions: readonly MonacoMenuAction[],
  keybindingFor: (action: MonacoMenuAction) => string | null,
  keyPrefix = '',
  include: ((action: MonacoMenuAction) => boolean) | null = null,
): EditorMenuEntry[] {
  const entries: EditorMenuEntry[] = [];
  actions.forEach((action, index) => {
    const key = `${keyPrefix}${index}:${action.id}`;
    if (action.id === monacoSeparatorId) {
      if (entries.length > 0 && entries.at(-1)?.kind !== 'separator') {
        entries.push({ kind: 'separator', key });
      }
      return;
    }
    if (Array.isArray(action.actions)) {
      const nested = editorMenuEntries(action.actions, keybindingFor, `${key}/`, include);
      if (nested.length > 0) {
        entries.push({
          kind: 'submenu',
          key,
          label: cleanMenuLabel(action.label),
          entries: nested,
        });
      }
      return;
    }
    if (include && !include(action)) return;
    entries.push({
      kind: 'action',
      key,
      label: cleanMenuLabel(action.label),
      enabled: action.enabled,
      checked: action.checked,
      keybinding: keybindingFor(action),
      action,
    });
  });
  while (entries.at(-1)?.kind === 'separator') entries.pop();
  return entries;
}

export function editorMenuAnchor(anchor: MonacoMenuAnchor): EditorMenuAnchor {
  if (typeof HTMLElement !== 'undefined' && anchor instanceof HTMLElement) {
    const bounds = anchor.getBoundingClientRect();
    return {
      x: bounds.left,
      y: bounds.top,
      width: bounds.width,
      height: bounds.height,
      element: true,
    };
  }
  if ('x' in anchor && typeof anchor.x === 'number') {
    return { x: anchor.x, y: anchor.y, width: 0, height: 0, element: false };
  }
  const event = anchor as { posx: number; posy: number };
  return { x: event.posx, y: event.posy, width: 0, height: 0, element: false };
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'Canceled';
}

type Listener = () => void;

let menuLanguage: () => string | null = () => null;
const actionOverrides = new Map<string, () => unknown>();

export function setEditorMenuLanguage(provider: () => string | null): () => void {
  menuLanguage = provider;
  return () => {
    if (menuLanguage === provider) menuLanguage = () => null;
  };
}

export function overrideEditorMenuAction(id: string, run: () => unknown): () => void {
  actionOverrides.set(id, run);
  return () => {
    if (actionOverrides.get(id) === run) actionOverrides.delete(id);
  };
}

let current: EditorMenuRequest | null = null;
let nextRequestId = 1;
const listeners = new Set<Listener>();

function publish(request: EditorMenuRequest | null): void {
  current = request;
  for (const listener of listeners) listener();
}

export function currentEditorMenu(): EditorMenuRequest | null {
  return current;
}

export function subscribeEditorMenu(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function editorMenuRequest(
  delegate: MonacoContextMenuDelegate,
  lookupKeybinding: (id: string) => ResolvedKeybinding | undefined,
  onSettled: (request: EditorMenuRequest) => void = () => undefined,
): EditorMenuRequest | null {
  const actions = delegate.getActions();
  if (actions.length === 0) return null;
  const entries = editorMenuEntries(
    actions,
    (action) =>
      (delegate.getKeyBinding?.(action) ?? lookupKeybinding(action.id))?.getLabel() ?? null,
    '',
    editorMenuActionFilter(menuLanguage(), actions),
  );
  if (entries.length === 0) return null;
  const active = typeof document === 'undefined' ? null : document.activeElement;
  const focusReturn =
    typeof HTMLElement !== 'undefined' && active instanceof HTMLElement && active !== document.body
      ? active
      : null;
  const context = delegate.getActionsContext?.() ?? null;
  let choice: MonacoMenuAction | null = null;
  let scheduled = false;
  let settled = false;
  const request: EditorMenuRequest = {
    id: nextRequestId++,
    anchor: editorMenuAnchor(delegate.getAnchor()),
    entries,
    focusReturn,
    chosen: () => choice !== null,
    close(next) {
      if (settled) return;
      if (next && choice === null) choice = next;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        settled = true;
        delegate.onHide?.(choice === null);
        onSettled(request);
        const chosen = choice;
        if (!chosen) return;
        setTimeout(() => {
          focusReturn?.focus({ preventScroll: true });
          const override = actionOverrides.get(chosen.id);
          const run = override
            ? override()
            : delegate.actionRunner
              ? delegate.actionRunner.run(chosen, context)
              : chosen.run(context);
          void Promise.resolve(run).catch((error: unknown) => {
            if (!isCancellation(error)) console.error(error);
          });
        }, 0);
      });
    },
  };
  return request;
}

export interface EditorMenuDocument extends EventTarget {
  readonly activeElement: Element | null;
  readonly body: unknown;
}

export function dismissEditorMenuOnOutsidePress(
  request: EditorMenuRequest,
  ownerDocument: EditorMenuDocument,
  isInsideMenu: (target: EventTarget | null) => boolean,
): () => void {
  const onPointerDown = (event: Event) => {
    if (isInsideMenu(event.target)) return;
    request.close(null);
    setTimeout(() => {
      if (request.chosen()) return;
      const active = ownerDocument.activeElement;
      if (active === null || active === ownerDocument.body || isInsideMenu(active)) {
        request.focusReturn?.focus({ preventScroll: true });
      }
    }, 0);
  };
  ownerDocument.addEventListener('pointerdown', onPointerDown, { capture: true });
  return () => ownerDocument.removeEventListener('pointerdown', onPointerDown, { capture: true });
}

export function editorContextMenuHandler(
  lookupKeybinding: (id: string) => ResolvedKeybinding | undefined,
): MonacoContextMenuHandler & { dismiss(): void } {
  return {
    configure: () => undefined,
    showContextMenu(delegate) {
      current?.close(null);
      const request = editorMenuRequest(delegate, lookupKeybinding, (settled) => {
        if (current === settled) publish(null);
      });
      if (request) publish(request);
    },
    dismiss() {
      current?.close(null);
    },
  };
}
