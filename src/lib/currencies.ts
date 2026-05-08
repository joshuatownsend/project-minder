// Frankfurter API supported currencies (base=USD). Single source of truth for
// the allowlist used by the PATCH validator, the settings dropdown, and formatCost.

export const SUPPORTED_CURRENCIES = [
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD",
  "SGD", "INR", "KRW", "MXN", "BRL", "ZAR", "SEK", "NOK", "DKK", "PLN",
  "CZK", "HUF", "RON", "BGN", "ILS", "TRY", "THB", "MYR", "PHP", "IDR",
] as const;

export const VALID_CURRENCIES = new Set(SUPPORTED_CURRENCIES);

// Currencies with no fractional unit — display whole numbers only.
export const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "IDR"]);

export const CURRENCY_NAMES: Record<string, string> = {
  USD: "US Dollar",        EUR: "Euro",               GBP: "British Pound",
  JPY: "Japanese Yen",     CHF: "Swiss Franc",        CAD: "Canadian Dollar",
  AUD: "Australian Dollar", NZD: "New Zealand Dollar", CNY: "Chinese Yuan",
  HKD: "Hong Kong Dollar", SGD: "Singapore Dollar",   INR: "Indian Rupee",
  KRW: "South Korean Won", MXN: "Mexican Peso",       BRL: "Brazilian Real",
  ZAR: "South African Rand", SEK: "Swedish Krona",    NOK: "Norwegian Krone",
  DKK: "Danish Krone",     PLN: "Polish Złoty",       CZK: "Czech Koruna",
  HUF: "Hungarian Forint", RON: "Romanian Leu",       BGN: "Bulgarian Lev",
  ILS: "Israeli Shekel",   TRY: "Turkish Lira",       THB: "Thai Baht",
  MYR: "Malaysian Ringgit", PHP: "Philippine Peso",   IDR: "Indonesian Rupiah",
};

export const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",   EUR: "€",   GBP: "£",   JPY: "¥",   CHF: "Fr",
  CAD: "CA$", AUD: "A$",  NZD: "NZ$", CNY: "¥",   HKD: "HK$",
  SGD: "S$",  INR: "₹",   KRW: "₩",   MXN: "MX$", BRL: "R$",
  ZAR: "R",   SEK: "kr",  NOK: "kr",  DKK: "kr",  PLN: "zł",
  CZK: "Kč",  HUF: "Ft",  RON: "lei", BGN: "лв",  ILS: "₪",
  TRY: "₺",   THB: "฿",   MYR: "RM",  PHP: "₱",   IDR: "Rp",
};
