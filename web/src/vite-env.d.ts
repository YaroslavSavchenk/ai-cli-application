/// <reference types="vite/client" />

/**
 * Bundle identity, replaced at build time by the `define` in vite.config.ts
 * (`<yyyymmdd-hhmm>-<git short hash>`). main.ts logs it in the boot line so a
 * server.log entry can be tied to the exact bundle that produced it.
 */
declare const __BUILD_ID__: string;
