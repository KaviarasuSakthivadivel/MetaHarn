import type { MetaHarnBridge, MetaHarnPtyBridge, MetaHarnFilesBridge } from "../preload/preload.js";

declare global {
  interface Window {
    metaharn: MetaHarnBridge;
    metaharnPty: MetaHarnPtyBridge;
    metaharnFiles: MetaHarnFilesBridge;
  }
}

export {};
