import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Project Minder",
  description: "Local dashboard for managing dev projects",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>
        <header className="border-b border-[var(--border)]">
          <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between">
            <a href="/" className="text-xl font-bold tracking-tight">
              Project Minder
            </a>
            <span className="text-xs text-[var(--muted-foreground)]">
              C:\dev
            </span>
          </div>
        </header>
        <main className="max-w-[1600px] mx-auto px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
