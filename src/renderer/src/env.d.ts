import type { ComandoApi } from '@shared/ipc';

declare global {
  interface Window {
    comando: ComandoApi;
  }
}

export {};
