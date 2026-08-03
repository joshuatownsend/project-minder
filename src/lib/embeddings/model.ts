import "server-only";
import fs from "fs";
import path from "path";
import os from "os";
import { EMBEDDING_DIMS, isUnitish } from "./quantize";

/**
 * Optional embedding runtime.
 *
 * `@huggingface/transformers` is an **optional dependency**, exactly like
 * `better-sqlite3`: the import is wrapped in try/catch and its absence
 * degrades the feature rather than breaking the build or the process. This
 * mirrors the posture `db/connection.ts` established, and it is what lets
 * semantic search fall back to BM25-only instead of failing.
 *
 * Three things this module is responsible for:
 *
 * 1. **Keeping the model out of `node_modules`.** The library's default
 *    `cacheDir` is inside its own package directory, so a `pnpm install`
 *    silently deletes the ~80 MB model and the next query re-downloads it.
 *    It is redirected to `~/.minder/models/`, next to the index database,
 *    where it survives dependency churn.
 *
 * 2. **Caching failure, not just success.** A missing package or a failed
 *    download must not be retried on every keystroke of a search box. The
 *    first failure is remembered and returns null immediately thereafter.
 *
 * 3. **Never throwing.** Every entry point resolves to a value; search must
 *    degrade, not 500.
 */

/**
 * Pinned. The model id is part of the stored vectors' identity — rows
 * embedded by a different model are not comparable and are filtered out at
 * query time rather than silently mixed in.
 */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

/** Where the ONNX weights live. Sibling of `~/.minder/index.db`. */
export function modelCacheDir(): string {
  return path.join(os.homedir(), ".minder", "models");
}

/**
 * Are there cached model files on disk for {@link EMBEDDING_MODEL}?
 *
 * Answers one question and only that one: whether the first use will have to
 * pull ~80 MB over the network. It deliberately does **not** claim the cache is
 * complete or valid — an interrupted download leaves files behind too, and the
 * only way to know for sure is to load the model, which is the very thing this
 * check exists to let the user decide about. Callers must word it as "files
 * found", not "ready".
 *
 * Never throws: an unreadable cache directory is reported as absent.
 */
export function modelCachePresent(): boolean {
  try {
    // transformers.js lays the cache out as `<cacheDir>/<org>/<model>/…`.
    const dir = path.join(modelCacheDir(), ...EMBEDDING_MODEL.split("/"));
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export interface Embedder {
  model: string;
  dims: number;
  /** Embed a batch. Returns one unit-length vector per input, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

type LoadState =
  | { kind: "unloaded" }
  | { kind: "loading"; promise: Promise<Embedder | null> }
  | { kind: "ready"; embedder: Embedder }
  | { kind: "failed"; reason: string };

const g = globalThis as unknown as { __minderEmbedder?: LoadState };

function state(): LoadState {
  g.__minderEmbedder ??= { kind: "unloaded" };
  return g.__minderEmbedder;
}

/** Why the embedder is unavailable, or null when it is available/untried. */
export function embedderFailure(): string | null {
  const s = state();
  return s.kind === "failed" ? s.reason : null;
}

/** True when the runtime is loaded and usable right now (no I/O). */
export function embedderReady(): boolean {
  return state().kind === "ready";
}

/**
 * Batch size for inference. Measured on this machine: 24.5 ms/text at
 * batch 1, 15.3 ms/text at batch 32 — a 1.6x throughput gain that flattens
 * out well before memory becomes a concern.
 */
export const EMBED_BATCH_SIZE = 32;

/**
 * Load the embedder, or return null if it can't be loaded.
 *
 * The first call downloads ~80 MB on a machine that has never used it.
 * That is why the `semanticSearch` feature flag ships **off**: turning it on
 * is the consent for that download, rather than it happening because someone
 * typed in a search box.
 */
export async function loadEmbedder(): Promise<Embedder | null> {
  const s = state();
  if (s.kind === "ready") return s.embedder;
  if (s.kind === "failed") return null;
  if (s.kind === "loading") return s.promise;

  const promise = (async (): Promise<Embedder | null> => {
    try {
      const mod = await import("@huggingface/transformers");
      // Redirect BEFORE the pipeline call — the library reads `env` at load
      // time, so setting it afterwards would cache into node_modules once.
      mod.env.cacheDir = modelCacheDir();

      const extractor = await mod.pipeline("feature-extraction", EMBEDDING_MODEL);

      const embedder: Embedder = {
        model: EMBEDDING_MODEL,
        dims: EMBEDDING_DIMS,
        async embed(texts: string[]): Promise<Float32Array[]> {
          if (texts.length === 0) return [];
          const output = await extractor(texts, { pooling: "mean", normalize: true });
          const rows = output.tolist() as number[][];
          return rows.map((row) => Float32Array.from(row));
        },
      };

      // Prove the contract once rather than trusting it: a build that
      // silently stopped normalizing would make every stored vector's
      // similarity meaningless, and int8 quantization assumes unit length.
      const [probe] = await embedder.embed(["probe"]);
      if (!probe || probe.length !== EMBEDDING_DIMS) {
        g.__minderEmbedder = {
          kind: "failed",
          reason: `model returned ${probe?.length ?? 0} dimensions, expected ${EMBEDDING_DIMS}`,
        };
        return null;
      }
      if (!isUnitish(probe)) {
        g.__minderEmbedder = {
          kind: "failed",
          reason: "model output is not unit-length; int8 quantization would be invalid",
        };
        return null;
      }

      g.__minderEmbedder = { kind: "ready", embedder };
      return embedder;
    } catch (err) {
      const reason =
        err instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(err.message)
          ? "@huggingface/transformers is not installed (optional dependency)"
          : `embedding model unavailable: ${err instanceof Error ? err.message : String(err)}`;
      g.__minderEmbedder = { kind: "failed", reason };
      return null;
    }
  })();

  g.__minderEmbedder = { kind: "loading", promise };
  return promise;
}

/** @internal Test seam — drops the cached load state. */
export function _resetEmbedderForTesting(): void {
  g.__minderEmbedder = { kind: "unloaded" };
}

/** @internal Test seam — inject a fake embedder without touching ONNX. */
export function _setEmbedderForTesting(embedder: Embedder | null, reason = "test"): void {
  g.__minderEmbedder = embedder ? { kind: "ready", embedder } : { kind: "failed", reason };
}
