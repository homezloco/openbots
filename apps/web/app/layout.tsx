import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AuthProvider } from "../components/AuthProvider";
import { NavBar } from "../components/NavBar";

export const metadata: Metadata = {
  title: "OpenBots",
  description: "Open-source, model-agnostic multi-agent orchestration",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <NavBar />
          <main style={{ height: "calc(100vh - 49px)" }}>{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
