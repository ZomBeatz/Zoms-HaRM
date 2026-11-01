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
