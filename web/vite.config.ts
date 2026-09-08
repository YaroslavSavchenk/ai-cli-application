/**
 * Shim: vite only looks for its config in the directory it is run FROM, so a
 * `vite build` started inside web/ used to build without the repo-root config
 * and its `__BUILD_ID__` define (2026-09-08 — the bare identifier threw a
 * ReferenceError in the boot path). The real config lives one level up.
 */
export { default } from '../vite.config.ts';
