import type { RmsideDesktopApi } from '../shared/api';

declare global {
  interface Window {
    rmside: RmsideDesktopApi;
  }
}

export {};
