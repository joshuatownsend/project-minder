import "server-only";
import type DatabaseT from "better-sqlite3";

/**
 * Prune notification_log rows older than 30 days. Called once per server
 * boot from the DB first-open hook. Failure is non-fatal — pruning must
 * never block server start.
 */
export function pruneNotificationLog(db: DatabaseT.Database): void {
  try {
    const result = db
      .prepare("DELETE FROM notification_log WHERE datetime(sent_at) < datetime('now', '-30 days')")
      .run();
    if (result.changes > 0) {
      console.info(`[maintenance] pruned ${result.changes} notification_log rows older than 30 days`);
    }
  } catch (err) {
    console.warn("[maintenance] notification_log prune failed (non-fatal):", err);
  }
}
