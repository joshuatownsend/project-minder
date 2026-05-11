// Single source of truth for the provider/framework/variant string-union
// types AND the runtime tuples + Sets that validate them. Defining the
// tuples first then deriving the type means the validators never drift
// from the union — adding a fourth provider here automatically widens
// the type, the env-key Record, and the API route's Set check.

export const PROVIDERS = ["gemini", "openai", "anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_SET: ReadonlySet<Provider> = new Set(PROVIDERS);

export const FRAMEWORKS = ["react", "react-tailwind"] as const;
export type Framework = (typeof FRAMEWORKS)[number];
export const FRAMEWORK_SET: ReadonlySet<Framework> = new Set(FRAMEWORKS);

export const VARIANTS = ["verbose", "minimal"] as const;
export type Variant = (typeof VARIANTS)[number];
export const VARIANT_SET: ReadonlySet<Variant> = new Set(VARIANTS);

export const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export const MEDIA_TYPE_SET: ReadonlySet<MediaType> = new Set(MEDIA_TYPES);

/** Sensible default model per provider. The user can override via the
 *  `model` field of `screenshotToCode` in `.minder.json` or per-call. */
export const PROVIDER_DEFAULT_MODEL: Record<Provider, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-5",
};

/** Convention-over-configuration default for which env var each provider
 *  pulls its key from. Matches each vendor's own CLI tools. */
export const PROVIDER_DEFAULT_ENV_VAR: Record<Provider, string> = {
  gemini: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/** Type guard for narrowing an unknown value into a union member.
 *  Removes the `as T` casts at call sites that previously had to
 *  re-state the type they'd just checked. */
export function isMember<T extends string>(
  value: unknown,
  set: ReadonlySet<T>,
): value is T {
  return typeof value === "string" && set.has(value as T);
}
