/* What other scripts put on window: the online demo (web-demo/demo-boot.js) and the barcode reader. */
interface Window {
  harmDemo?: { download(url: string): void };
  ZXing?: any;
  toast?: (msg: string, kind?: string) => void;
  harm?: Record<string, unknown>;
}
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

/* noVNC ships without types: the parts of its viewer HaRM's screen page uses (pages/Vnc.tsx). */
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { wsProtocols?: string[]; credentials?: { username?: string; password?: string } });
    scaleViewport: boolean;
    viewOnly: boolean;
    background: string;
    focus(): void;
    disconnect(): void;
    sendCtrlAltDel(): void;
    sendCredentials(c: { username?: string; password?: string }): void;
    addEventListener(type: string, fn: (e: CustomEvent) => void): void;
  }
}
