"use client";

import { useTheme, type ThemeMode } from "./ThemeProvider";

const NEXT_MODE: Record<ThemeMode, ThemeMode> = { light: "dark", dark: "system", system: "light" };
const ICON: Record<ThemeMode, string> = { light: "☀️", dark: "🌙", system: "🖥️" };

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <button onClick={() => setMode(NEXT_MODE[mode])} title={`Theme: ${mode} (click to change)`}>
      {ICON[mode]} {mode}
    </button>
  );
}
