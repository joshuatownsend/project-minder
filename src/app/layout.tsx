import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { HelpProvider } from "@/components/HelpProvider";
import { HelpPanel } from "@/components/HelpPanel";
import { HelpButton } from "@/components/HelpButton";
import { ToastProvider } from "@/components/ToastProvider";
import { NotificationListener } from "@/components/NotificationListener";
import { AppNav } from "@/components/AppNav";
import { PulseProvider } from "@/components/PulseProvider";
import { PortConflictIndicator } from "@/components/PortConflictIndicator";
import { readConfig, getDevRoots } from "@/lib/config";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Project Minder",
  description: "Local dashboard for managing dev projects",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const config = await readConfig();
  const devRoots = getDevRoots(config);
  const rootLabel = devRoots.length === 1
    ? devRoots[0]
    : `${devRoots[0]} +${devRoots.length - 1} more`;
  return (
    <html
      lang="en"
      className={`dark ${geist.variable} ${geistMono.variable}`}
    >
      <body suppressHydrationWarning>
        <ToastProvider>
          <HelpProvider>
            <PulseProvider>
            <header
              style={{
                borderBottom: "1px solid var(--border-subtle)",
                background: "var(--bg-base)",
              }}
            >
              <div
                style={{
                  maxWidth: "1600px",
                  margin: "0 auto",
                  padding: "0 24px",
                  height: "48px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "24px",
                }}
              >
                {/* Wordmark */}
                <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
                  <a
                    href="/"
                    style={{
                      fontFamily: "var(--font-body)",
                      fontWeight: 600,
                      fontSize: "0.9rem",
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--text-primary)",
                      textDecoration: "none",
                      lineHeight: 1,
                    }}
                  >
                    Project Minder
                  </a>

                  {/* Nav — Suspense wraps AppNav because it reads
                      useSearchParams() to compute /config?type= active state. */}
                  <Suspense fallback={null}>
                    <AppNav />
                  </Suspense>
                </div>

                {/* Right side */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <PortConflictIndicator />
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.7rem",
                      color: "var(--text-muted)",
                      letterSpacing: "0.02em",
                    }}
                  >
                    {rootLabel}
                  </span>
                  <HelpButton />
                </div>
              </div>
            </header>

            <main
              style={{
                maxWidth: "1600px",
                margin: "0 auto",
                padding: "24px",
              }}
            >
              {children}
            </main>

            <HelpPanel />
            <NotificationListener />
            </PulseProvider>
          </HelpProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
