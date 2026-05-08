import { CronExpressionParser } from "cron-parser";

// Thin wrapper around cron-parser v5's CronExpressionParser.
// cron-parser v5 API: CronExpressionParser.parse(expr) → CronExpression
// CronExpression.next() → CronDate; CronDate.toDate() → Date

export interface CronValidationResult {
  ok: true;
  nextRun: Date;
}

export interface CronValidationError {
  ok: false;
  error: string;
}

/**
 * Validate a 5-field standard cron expression (min hour dom mon dow).
 * Returns the next scheduled run date on success, or an error string on failure.
 */
export function validateCron(
  expr: string
): CronValidationResult | CronValidationError {
  try {
    const parsed = CronExpressionParser.parse(expr.trim());
    const nextRun = parsed.next().toDate();
    return { ok: true, nextRun };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Compute the next run time after `after` (defaults to now).
 * Returns null when cron-parser throws (invalid expression or past-end iterator).
 */
export function computeNextRun(expr: string, after?: Date): Date | null {
  try {
    const parsed = CronExpressionParser.parse(expr.trim(), {
      currentDate: after ?? new Date(),
    });
    return parsed.next().toDate();
  } catch {
    return null;
  }
}
