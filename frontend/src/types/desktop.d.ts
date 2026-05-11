export {};

declare global {
  interface Window {
    quokkaDesktop?: {
      app: string;
      openFile?: (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>;
      openFolder?: (options?: { title?: string }) => Promise<string | null>;
      openExternal?: (url: string) => Promise<boolean>;
      runUpdate?: (payload?: { installerUrl?: string | null; releaseUrl?: string | null }) => Promise<{ ok: boolean; message: string }>;
    };
  }
}
