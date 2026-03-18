import type { Metadata } from "next";
import "./globals.css";
import { HelpProvider } from "@/components/HelpProvider";
import { HelpPanel } from "@/components/HelpPanel";
import { HelpButton } from "@/components/HelpButton";
import { ToastProvider } from "@/components/ToastProvider";
import { NotificationListener } from "@/components/NotificationListener";
import { ManualStepsNavBadge } from "@/components/ManualStepsNavBadge";
import { readConfig } from "@/lib/config";

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
  return (
    <html lang="en" className="dark">
      <body>
        <ToastProvider>
          <HelpProvider>
            <header className="border-b border-[var(--border)]">
              <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-6">
                  <a href="/" className="text-xl font-bold tracking-tight">
                    Project Minder
                  </a>
                  <nav className="flex items-center gap-4">
                    <ManualStepsNavBadge />
                    <a
                      href="/sessions"
                      className="flex items-center gap-1.5 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                    >
                      Sessions
                    </a>
                    <a
                      href="/stats"
                      className="flex items-center gap-1.5 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                    >
                      Stats
                    </a>
                  </nav>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-[var(--muted-foreground)]">
                    {config.devRoot}
                  </span>
                  <HelpButton />
                </div>
              </div>
            </header>
            <main className="max-w-[1600px] mx-auto px-6 py-6">{children}</main>
            <HelpPanel />
            <NotificationListener />
          </HelpProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
