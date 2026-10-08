declare module 'monaco-editor/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: {
    get<T>(id: unknown): T;
  };
}

declare module 'monaco-editor/platform/contextview/browser/contextView.js' {
  export const IContextMenuService: unknown;
}

declare module 'monaco-editor/platform/keybinding/common/keybinding.js' {
  export const IKeybindingService: unknown;
}
