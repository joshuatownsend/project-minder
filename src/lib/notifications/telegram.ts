import "server-only";
import { readConfig } from "@/lib/config";
import { getSecret } from "@/lib/llm/secretsStore";
import { shouldSend, logNotification } from "@/lib/push/dedup";

const MAX_TEXT_LEN = 4000;

function truncate(text: string): string {
  if (text.length <= MAX_TEXT_LEN) return text;
  return text.slice(0, MAX_TEXT_LEN - 1) + "…";
}

export async function sendTelegram(
  text: string,
  eventKey?: string
): Promise<{ ok: boolean; status: number; error?: string }> {
  const token = await getSecret("telegram.bot_token");
  const config = await readConfig();
  const chatId = config.telegram?.chatId;

  if (!token || !chatId) {
    return { ok: false, status: 0, error: "Telegram not configured" };
  }

  const payload = { chat_id: chatId, text: truncate(text) };
  const key = eventKey ?? `telegram.send:${Date.now()}`;

  if (!(await shouldSend("telegram", key, payload))) {
    return { ok: true, status: 200 };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      await logNotification("telegram", key, payload, "failed", errText);
      return { ok: false, status: res.status, error: errText };
    }
    await logNotification("telegram", key, payload, "sent");
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = String(err);
    await logNotification("telegram", key, payload, "failed", msg);
    return { ok: false, status: 0, error: msg };
  }
}

/**
 * Send a Telegram message using caller-supplied credentials (test path only).
 * Does NOT persist the token. Does NOT dedup.
 */
export async function sendTelegramDirect(
  botToken: string,
  chatId: string,
  text: string
): Promise<{ ok: boolean; status: number; error?: string }> {
  const payload = { chat_id: chatId, text: truncate(text) };
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: errText };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}
