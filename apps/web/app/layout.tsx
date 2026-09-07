import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenBots",
  description: "Open-source, model-agnostic multi-agent orchestration",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav style={{ display: "flex", gap: 16, padding: "12px 24px", borderBottom: "1px solid #eee" }}>
          <strong>OpenBots</strong>
          <a href="/dashboard">Dashboard</a>
          <a href="/hierarchy">Hierarchy</a>
        </nav>
        <main style={{ height: "calc(100vh - 49px)" }}>{children}</main>
      </body>
    </html>
  );
}
