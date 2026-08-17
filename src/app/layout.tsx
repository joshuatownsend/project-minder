import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { HelpProvider } from "@/components/HelpProvider";
import { HelpPanel } from "@/components/HelpPanel";
import { ToastProvider } from "@/components/ToastProvider";
import { NotificationListener } from "@/components/NotificationListener";
import { ClaudeStatusProvider } from "@/components/ClaudeStatusProvider";
import { PulseProvider } from "@/components/PulseProvider";
import { EmergencyStopButton } from "@/components/EmergencyStopButton";
import { readConfig, getDevRoots } from "@/lib/config";
import { demoMode } from "@/lib/demo/demoMode";
import { DEMO_DEV_ROOT } from "@/lib/demo/projects";
import { getFlag } from "@/lib/featureFlags";
import { ConfigProvider } from "@/components/ConfigProvider";
import { QueryProvider } from "@/components/QueryProvider";
import { LiveEventsProvider } from "@/components/LiveEventsProvider";
import { CommandPaletteProvider } from "@/components/CommandPaletteProvider";
import { ScopeProvider } from "@/components/ScopeProvider";
import { AppShell } from "@/components/AppShell";

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
  // The shell prints the configured dev root on every route. It is a server
  // component, so it passes through neither the `data/index.ts` façade nor any
  // API route — there is no guard upstream of it, which is exactly how this one
  // survived the route-by-route audit. In demo mode it reports the root the
  // synthetic projects actually hang off instead of the user's real one.
  const devRoots = (await demoMode()) ? [DEMO_DEV_ROOT] : getDevRoots(config);
  const rootLabel =
    devRoots.length === 1
      ? devRoots[0]
      : `${devRoots[0]} +${devRoots.length - 1} more`;
  const taskDispatcherEnabled = getFlag(config.featureFlags, "taskDispatcher", false);

  return (
    <html
      lang="en"
      className={`dark ${geist.variable} ${geistMono.variable}`}
    >
      <body suppressHydrationWarning>
        <ToastProvider>
          <ConfigProvider>
            <QueryProvider>
              <LiveEventsProvider>
              <PulseProvider>
                <CommandPaletteProvider>
                  <HelpProvider>
                    {/* One shared claude-status poll feeds both the banner (in
                        AppShell) and the toast listener folded into the provider. */}
                    <ClaudeStatusProvider>
                      {/* Suspense wraps client providers that read useSearchParams() */}
                      <Suspense fallback={null}>
                        <ScopeProvider>
                          <AppShell devRootLabel={rootLabel}>
                            {/* Floating emergency stop, only when task dispatcher is on */}
                            {taskDispatcherEnabled && (
                              <div
                                style={{
                                  position: "fixed",
                                  top: 12,
                                  right: 12,
                                  zIndex: 30,
                                }}
                              >
                                <EmergencyStopButton />
                              </div>
                            )}
                            {children}
                          </AppShell>
                        </ScopeProvider>
                      </Suspense>

                      <HelpPanel />
                      <NotificationListener />
                    </ClaudeStatusProvider>
                  </HelpProvider>
                </CommandPaletteProvider>
              </PulseProvider>
              </LiveEventsProvider>
            </QueryProvider>
          </ConfigProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
