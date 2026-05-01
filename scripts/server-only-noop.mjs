// Empty stub used by `scripts/build-worker.mjs` to neutralize
// `import "server-only"` inside the worker bundle. The real package
// throws by design when imported into a client component; the worker
// is server-side, so the guard is irrelevant. Next.js's main-thread
// resolution still sees the original `server-only` package specifier.
export {};
