// Type-only stubs for the renderer's dev-only instrumentation (@/debug/*).
// At runtime the Vite alias keeps the real modules in dev and noops in prod;
// for typecheck we never pull the upstream debug graph (it needs bippy, a
// desktop devDep outside the web closure).
export {}

/** Upstream: export function markRightPanePerf(event: RightPanePerfEvent, detail?: string): void */
export function markRightPanePerf(_event: string, _detail?: string): void {}
