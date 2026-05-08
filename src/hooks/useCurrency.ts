"use client";

import { useEffect, useState } from "react";

interface CurrencyState {
  currency: string;
  fxRate: number;
}

// Module-level cache: all hook instances on the same page share one fetch pair.
// Cleared when currency changes (CostSection calls invalidateCurrencyCache).
let currencyCache: CurrencyState | null = null;
let currencyLoadPromise: Promise<CurrencyState> | null = null;

export function invalidateCurrencyCache() {
  currencyCache = null;
  currencyLoadPromise = null;
}

async function loadCurrency(): Promise<CurrencyState> {
  if (currencyCache) return currencyCache;
  if (!currencyLoadPromise) {
    currencyLoadPromise = (async () => {
      try {
        const configRes = await fetch("/api/config");
        if (!configRes.ok) {
          currencyLoadPromise = null;
          return { currency: "USD", fxRate: 1 };
        }
        const config = (await configRes.json()) as Record<string, unknown>;
        const currency = (typeof config.currency === "string" ? config.currency : null) ?? "USD";

        if (currency === "USD") {
          currencyCache = { currency: "USD", fxRate: 1 };
          return currencyCache;
        }

        const fxRes = await fetch("/api/integrations/fx");
        if (!fxRes.ok) {
          currencyCache = { currency, fxRate: 1 };
          return currencyCache;
        }
        const fx = (await fxRes.json()) as { rates: Record<string, number> };
        currencyCache = { currency, fxRate: fx.rates[currency] ?? 1 };
        return currencyCache;
      } catch {
        currencyCache = { currency: "USD", fxRate: 1 };
        return currencyCache;
      }
    })();
  }
  return currencyLoadPromise;
}

export function useCurrency(): CurrencyState {
  const [state, setState] = useState<CurrencyState>({ currency: "USD", fxRate: 1 });

  useEffect(() => {
    let cancelled = false;
    loadCurrency().then((s) => { if (!cancelled) setState(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return state;
}
