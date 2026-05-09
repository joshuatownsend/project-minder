import type { UsageReport } from "./usage/types";
import type { Period } from "./usage/constants";
import { computeActivityTiers } from "./usage/chartTiers";

export interface ShareImageOptions {
  theme?: "dark" | "light";
  period?: Period;
  width?: number;
}

// Hex palettes converted from globals.css OKLCH values.
// Dark: oklch tokens → approximate sRGB hex.
// Light: invented neutral inversion (app has no light mode yet).
const PALETTES = {
  dark: {
    bg: "#0f1116",
    surface: "#1a1d24",
    elevated: "#252830",
    border: "#2e3039",
    textPrimary: "#e9e8ee",
    textSecondary: "#8f949d",
    textMuted: "#5e6167",
    accent: "#c89b24",
    info: "#5b9cbe",
    success: "#3db56b",
    error: "#d45f45",
  },
  light: {
    bg: "#f8f8fb",
    surface: "#ffffff",
    elevated: "#f0f0f5",
    border: "#dde0e8",
    textPrimary: "#1a1d24",
    textSecondary: "#555a65",
    textMuted: "#888d97",
    accent: "#b8860b",
    info: "#2d7a9e",
    success: "#1d8a49",
    error: "#c0392b",
  },
} as const;

const WIDTH = 1200;
const HEIGHT = 800;
const PAD = 40;
const INNER_W = WIDTH - PAD * 2;

export function composeShareSvg(
  report: UsageReport,
  opts: ShareImageOptions = {},
): string {
  const theme = opts.theme ?? "dark";
  const period = opts.period ?? "month";
  const width = opts.width ?? WIDTH;
  const height = Math.round((width / WIDTH) * HEIGHT);
  const p = PALETTES[theme];

  const periodLabel: Record<Period, string> = {
    today: "Today",
    week: "This Week",
    month: "This Month",
    all: "All Time",
  };

  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="system-ui, -apple-system, sans-serif">`,
  );

  // Background
  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${p.bg}"/>`);

  // Header
  const headerY = PAD;
  parts.push(
    `<text x="${PAD}" y="${headerY + 24}" font-size="22" font-weight="700" fill="${p.textPrimary}">Project Minder</text>`,
  );
  parts.push(
    `<text x="${PAD}" y="${headerY + 44}" font-size="13" fill="${p.textSecondary}">${periodLabel[period]} · ${report.generatedAt ? new Date(report.generatedAt).toLocaleDateString() : ""}</text>`,
  );

  // ── Row 1: 4 KPI cards ────────────────────────────────────────────────────
  const cardY = PAD + 64;
  const cardH = 110;
  const cardW = (INNER_W - 24) / 4;
  const kpis = [
    { label: "Sessions", value: String(report.totalSessions) },
    { label: "Cost", value: `$${report.totalCost.toFixed(2)}` },
    { label: "Tokens", value: fmtTokens(report.totalTokens) },
    { label: "Streak", value: `${report.streak.currentDays}d` },
  ];
  kpis.forEach((kpi, i) => {
    const x = PAD + i * (cardW + 8);
    parts.push(
      `<rect x="${x}" y="${cardY}" width="${cardW}" height="${cardH}" rx="8" fill="${p.surface}" stroke="${p.border}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${x + cardW / 2}" y="${cardY + 38}" text-anchor="middle" font-size="36" font-weight="700" fill="${p.textPrimary}">${kpi.value}</text>`,
    );
    parts.push(
      `<text x="${x + cardW / 2}" y="${cardY + 62}" text-anchor="middle" font-size="13" fill="${p.textSecondary}">${kpi.label}</text>`,
    );
  });

  // ── Row 2: 24-hour activity strip ─────────────────────────────────────────
  const stripY = cardY + cardH + 28;
  parts.push(
    `<text x="${PAD}" y="${stripY - 8}" font-size="12" fill="${p.textMuted}">Activity by hour of day</text>`,
  );
  const hourCosts = report.byHourOfDay.map((b) => b.cost);
  const tiers = computeActivityTiers(hourCosts);
  const barW = Math.floor((INNER_W - 23) / 24);
  const barH = 40;
  for (let h = 0; h < 24; h++) {
    const val = hourCosts[h] ?? 0;
    const fill = tierFillHex(val, tiers, p.accent, p.elevated);
    const x = PAD + h * (barW + 1);
    parts.push(
      `<rect x="${x}" y="${stripY}" width="${barW}" height="${barH}" rx="3" fill="${fill}"/>`,
    );
    if (h % 6 === 0) {
      parts.push(
        `<text x="${x + barW / 2}" y="${stripY + barH + 14}" text-anchor="middle" font-size="10" fill="${p.textMuted}">${h}h</text>`,
      );
    }
  }

  // ── Row 3: Top projects + by-model stacked bar ───────────────────────────
  const row3Y = stripY + barH + 36;
  const halfW = (INNER_W - 24) / 2;

  // Left: top-5 projects
  parts.push(
    `<text x="${PAD}" y="${row3Y - 8}" font-size="12" fill="${p.textMuted}">Top projects by cost</text>`,
  );
  const topProjects = report.byProject.slice(0, 5);
  const maxProjCost = topProjects[0]?.cost ?? 1;
  topProjects.forEach((proj, i) => {
    const barY = row3Y + i * 38;
    const filled = Math.max(4, Math.round((proj.cost / maxProjCost) * halfW));
    parts.push(
      `<rect x="${PAD}" y="${barY}" width="${halfW}" height="26" rx="4" fill="${p.elevated}"/>`,
    );
    parts.push(
      `<rect x="${PAD}" y="${barY}" width="${filled}" height="26" rx="4" fill="${p.info}"/>`,
    );
    const name = proj.projectDirName.length > 28 ? proj.projectDirName.slice(0, 26) + "…" : proj.projectDirName;
    parts.push(
      `<text x="${PAD + 8}" y="${barY + 17}" font-size="12" fill="${p.textPrimary}" dominant-baseline="middle">${escSvg(name)}</text>`,
    );
    parts.push(
      `<text x="${PAD + halfW - 4}" y="${barY + 17}" text-anchor="end" font-size="11" fill="${p.textSecondary}" dominant-baseline="middle">$${proj.cost.toFixed(2)}</text>`,
    );
  });

  // Right: by-model stacked bar
  const rightX = PAD + halfW + 24;
  parts.push(
    `<text x="${rightX}" y="${row3Y - 8}" font-size="12" fill="${p.textMuted}">Cost by model</text>`,
  );
  const models = report.byModel.slice(0, 6);
  const totalModelCost = models.reduce((s, m) => s + m.cost, 0) || 1;
  const modelColors = [p.accent, p.info, p.success, p.error, p.textSecondary, p.textMuted];
  let stackX = rightX;
  const stackH = 26;
  const stackBarWidth = halfW;
  models.forEach((m, i) => {
    const segW = Math.round((m.cost / totalModelCost) * stackBarWidth);
    if (segW < 2) return;
    parts.push(
      `<rect x="${stackX}" y="${row3Y}" width="${segW}" height="${stackH}" fill="${modelColors[i % modelColors.length]}"/>`,
    );
    stackX += segW;
  });
  // Legend rows
  models.forEach((m, i) => {
    const legY = row3Y + stackH + 10 + i * 22;
    const modelName = m.model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
    parts.push(
      `<rect x="${rightX}" y="${legY}" width="10" height="10" rx="2" fill="${modelColors[i % modelColors.length]}"/>`,
    );
    parts.push(
      `<text x="${rightX + 14}" y="${legY + 9}" font-size="11" fill="${p.textSecondary}">${escSvg(modelName.length > 30 ? modelName.slice(0, 28) + "…" : modelName)}</text>`,
    );
    parts.push(
      `<text x="${rightX + halfW}" y="${legY + 9}" text-anchor="end" font-size="11" fill="${p.textMuted}">$${m.cost.toFixed(2)}</text>`,
    );
  });

  // Footer
  parts.push(
    `<text x="${WIDTH - PAD}" y="${HEIGHT - PAD + 14}" text-anchor="end" font-size="11" fill="${p.textMuted}">projectminder.local</text>`,
  );

  parts.push(`</svg>`);
  return parts.join("\n");
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function escSvg(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Convert a cost value + 5-tier thresholds into a hex color.
// Interpolates between transparent and full accent based on tier membership.
function tierFillHex(val: number, tiers: number[], accentHex: string, baseHex: string): string {
  if (val === 0) return baseHex;
  if (val <= tiers[0]) return blendHex(accentHex, baseHex, 0.25);
  if (val <= tiers[1]) return blendHex(accentHex, baseHex, 0.45);
  if (val <= tiers[2]) return blendHex(accentHex, baseHex, 0.60);
  if (val <= tiers[3]) return blendHex(accentHex, baseHex, 0.78);
  return accentHex;
}

function blendHex(fg: string, bg: string, alpha: number): string {
  const fr = parseInt(fg.slice(1, 3), 16);
  const fg2 = parseInt(fg.slice(3, 5), 16);
  const fb = parseInt(fg.slice(5, 7), 16);
  const br = parseInt(bg.slice(1, 3), 16);
  const bg2 = parseInt(bg.slice(3, 5), 16);
  const bb = parseInt(bg.slice(5, 7), 16);
  const r = Math.round(fr * alpha + br * (1 - alpha));
  const g = Math.round(fg2 * alpha + bg2 * (1 - alpha));
  const b = Math.round(fb * alpha + bb * (1 - alpha));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
