// Barrel for the Project Minder shared type surface.
//
// `@/lib/types` was a single 1500-line module; it is now sliced into cohesive
// domain modules under `src/lib/types/`. This barrel re-exports every one of
// them so the public `@/lib/types` import surface is byte-for-byte identical
// for the ~190 files that import from it — no importer needs to change.
//
// When adding a new type, put it in the domain module it belongs to (or add a
// new one and re-export it here); do not grow this file with definitions.
export * from "./init";
export * from "./project";
export * from "./session";
export * from "./memory";
export * from "./github";
export * from "./audit";
export * from "./lint";
export * from "./checklist";
export * from "./board";
export * from "./cicd";
export * from "./ops";
export * from "./claudeConfig";
export * from "./stats";
export * from "./config";
export * from "./template";
export * from "./mcpSecurity";
