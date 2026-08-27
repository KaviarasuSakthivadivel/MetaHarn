/// <reference types="vite/client" />

// Injected by vite.config.ts's `define` — resolved at build/dev-server time from
// @metaharn/server's own per-launch token file, never fetched over the network.
declare const __METAHARN_SERVER_URL__: string;
declare const __METAHARN_WS_URL__: string;
declare const __METAHARN_TOKEN__: string;
