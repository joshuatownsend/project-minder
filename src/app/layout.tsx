import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { HelpProvider } from "@/components/HelpProvider";
import { HelpPanel } from "@/components/HelpPanel";
import { ToastProvider } from "@/components/ToastProvider";
import { NotificationListener } from "@/components/NotificationListener";
import { PulseProvider } from "@/components/PulseProvider";
import { EmergencyStopButton } from "@/components/EmergencyStopButton";
import { readConfig, getDevRoots } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { ConfigProvider } from "@/components/ConfigProvider";
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
  const devRoots = getDevRoots(config);
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
            <PulseProvider>
              <CommandPaletteProvider>
                <HelpProvider>
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
                </HelpProvider>
              </CommandPaletteProvider>
            </PulseProvider>
          </ConfigProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
