import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { AuthProvider } from "../components/AuthProvider";
import { ThemeProvider } from "../components/ThemeProvider";
import { NavBar } from "../components/NavBar";

export const metadata: Metadata = {
  title: "OpenBots",
  description: "Open-source, model-agnostic multi-agent orchestration",
};

// Sets data-theme before React hydrates, so there's no flash of the wrong
// theme — ThemeProvider takes over from here once it mounts.
const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem("openbots-theme-mode");
    var theme = stored === "light" || stored === "dark"
      ? stored
      : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <NavBar />
            <main style={{ height: "calc(100vh - 49px)" }}>{children}</main>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
