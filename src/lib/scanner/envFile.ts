import { promises as fs } from "fs";
import path from "path";
import { DatabaseInfo } from "../types";

interface EnvResult {
  database?: DatabaseInfo;
  externalServices: string[];
}

const SERVICE_PATTERNS: Record<string, string[]> = {
  Anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  OpenAI: ["OPENAI_API_KEY"],
  Stripe: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET"],
  Supabase: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL"],
  AWS: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
  S3: ["S3_BUCKET", "AWS_S3_BUCKET"],
  Vercel: ["VERCEL_TOKEN", "VERCEL_PROJECT_ID"],
  Resend: ["RESEND_API_KEY"],
  Clerk: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
  "Auth.js": ["AUTH_SECRET", "NEXTAUTH_SECRET"],
  Twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
  SendGrid: ["SENDGRID_API_KEY"],
  Redis: ["REDIS_URL", "REDIS_HOST"],
  Sentry: ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"],
  Cloudflare: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  Firebase: ["FIREBASE_API_KEY", "NEXT_PUBLIC_FIREBASE_API_KEY"],
  GitHub: ["GITHUB_TOKEN", "GITHUB_CLIENT_ID"],
  Google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  Pusher: ["PUSHER_APP_ID", "PUSHER_KEY"],
  Upstash: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
};

function parseDatabaseUrl(url: string): DatabaseInfo | undefined {
  try {
    // Handle postgres:// and postgresql://
    const normalized = url.replace(/^postgresql:\/\//, "postgres://");
    if (
      !normalized.startsWith("postgres://") &&
      !normalized.startsWith("mysql://") &&
      !normalized.startsWith("mongodb://") &&
      !normalized.startsWith("mongodb+srv://")
    ) {
      return undefined;
    }

    const parsed = new URL(normalized);
    let type = "PostgreSQL";
    if (url.startsWith("mysql")) type = "MySQL";
    if (url.startsWith("mongodb")) type = "MongoDB";

    return {
      type,
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || (type === "PostgreSQL" ? 5432 : type === "MySQL" ? 3306 : 27017),
      name: parsed.pathname.replace("/", ""),
    };
  } catch {
    return undefined;
  }
}

export async function scanEnvFiles(projectPath: string): Promise<EnvResult> {
  const result: EnvResult = { externalServices: [] };
  const envFiles = [".env", ".env.local", ".env.example", ".env.development"];
  const allKeys = new Set<string>();

  for (const envFile of envFiles) {
    try {
      const content = await fs.readFile(
        path.join(projectPath, envFile),
        "utf-8"
      );
      const lines = content.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;

        const key = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 1).trim().replace(/^["']|["']$/g, "");
        allKeys.add(key);

        // Parse DATABASE_URL
        if (
          (key === "DATABASE_URL" || key === "DB_URL" || key === "MONGODB_URI") &&
          value &&
          !result.database
        ) {
          result.database = parseDatabaseUrl(value);
        }
      }
    } catch {
      // File doesn't exist
    }
  }

  // Detect services from key names
  const detectedServices = new Set<string>();
  for (const [service, patterns] of Object.entries(SERVICE_PATTERNS)) {
    for (const pattern of patterns) {
      if (allKeys.has(pattern)) {
        detectedServices.add(service);
        break;
      }
    }
  }

  result.externalServices = Array.from(detectedServices).sort();
  return result;
}
