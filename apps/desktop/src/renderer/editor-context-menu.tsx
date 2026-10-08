import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { StandaloneServices } from 'monaco-editor/editor/standalone/browser/standaloneServices.js';
import { IContextMenuService } from 'monaco-editor/platform/contextview/browser/contextView.js';
import { IKeybindingService } from 'monaco-editor/platform/keybinding/common/keybinding.js';

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import {
  currentEditorMenu,
  dismissEditorMenuOnOutsidePress,
  editorContextMenuHandler,
  subscribeEditorMenu,
  type EditorMenuEntry,
  type EditorMenuRequest,
  type MonacoContextMenuHandler,
  type ResolvedKeybinding,
} from './monaco-context-menu';
import { useHeld } from './motion';

export function useEditorContextMenuSeam(): void {
  useEffect(() => {
    const service = StandaloneServices.get<{
      _contextMenuHandler: MonacoContextMenuHandler | undefined;
    }>(IContextMenuService);
    const keybindings = StandaloneServices.get<{
      lookupKeybinding(id: string): ResolvedKeybinding | undefined;
    }>(IKeybindingService);
    if (!('_contextMenuHandler' in service)) {
      throw new Error('Monaco 0.56 context menu handler seam is unavailable');
    }
    const previous = service._contextMenuHandler;
    const handler = editorContextMenuHandler((id) => keybindings.lookupKeybinding(id));
    service._contextMenuHandler = handler;
    return () => {
      if (service._contextMenuHandler === handler) service._contextMenuHandler = previous;
      handler.dismiss();
    };
  }, []);
}

function EditorMenuEntries({
  entries,
  request,
}: {
  entries: readonly EditorMenuEntry[];
  request: EditorMenuRequest;
}) {
  return entries.map((entry) => {
    if (entry.kind === 'separator') return <ContextMenuSeparator key={entry.key} />;
    if (entry.kind === 'submenu') {
      return (
        <ContextMenuSub key={entry.key}>
          <ContextMenuSubTrigger>{entry.label}</ContextMenuSubTrigger>
          <ContextMenuSubContent className="editor-context-menu">
            <EditorMenuEntries entries={entry.entries} request={request} />
          </ContextMenuSubContent>
        </ContextMenuSub>
      );
    }
    const content = (
      <>
        {entry.label}
        {entry.keybinding ? <ContextMenuShortcut>{entry.keybinding}</ContextMenuShortcut> : null}
      </>
    );
    if (entry.checked !== undefined) {
      return (
        <ContextMenuCheckboxItem
          checked={entry.checked}
          disabled={!entry.enabled}
          key={entry.key}
          onClick={() => request.close(entry.action)}
        >
          {content}
        </ContextMenuCheckboxItem>
      );
    }
    return (
      <ContextMenuItem
        disabled={!entry.enabled}
        key={entry.key}
        onClick={() => request.close(entry.action)}
      >
        {content}
      </ContextMenuItem>
    );
  });
}

function isInsideEditorMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.editor-context-menu') !== null;
}

export function EditorContextMenu() {
  const live = useSyncExternalStore(subscribeEditorMenu, currentEditorMenu);
  const request = useHeld(live, live === null);
  useLayoutEffect(() => {
    if (!live) return undefined;
    return dismissEditorMenuOnOutsidePress(live, document, isInsideEditorMenu);
  }, [live]);
  const anchor = useMemo(() => {
    if (!request) return undefined;
    const { x, y, width, height } = request.anchor;
    return {
      getBoundingClientRect: () => DOMRect.fromRect({ x, y, width, height }),
    };
  }, [request]);
  if (!request) return null;
  return (
    <ContextMenu
      key={request.id}
      open={live !== null}
      onOpenChange={(open) => {
        if (!open) request.close(null);
      }}
    >
      <ContextMenuContent
        anchor={anchor}
        className="editor-context-menu"
        collisionBoundary={
          document.querySelector<HTMLElement>('.workspace-editor-region') ?? undefined
        }
        finalFocus={false}
        {...(request.anchor.element ? { side: 'bottom' as const, alignOffset: 0 } : {})}
      >
        <EditorMenuEntries entries={request.entries} request={request} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
