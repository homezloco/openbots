"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { ThemeToggle } from "./ThemeToggle";

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/" && pathname.startsWith(href));
  return (
    <a
      href={href}
      style={{
        textDecoration: "none",
        padding: "4px 8px",
        borderRadius: 4,
        background: active ? "var(--bg-hover)" : "transparent",
        fontWeight: active ? 600 : 400,
        color: "var(--text)",
      }}
      aria-current={active ? "page" : undefined}
    >
      {children}
    </a>
  );
}

export function NavBar() {
  const { user, loading, logout } = useAuth();

  return (
    <nav style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 24px", borderBottom: "1px solid var(--border)" }}>
      <strong style={{ fontSize: 18 }}>OpenBots</strong>
      <NavLink href="/dashboard">Dashboard</NavLink>
      <NavLink href="/hierarchy">Hierarchy</NavLink>
      <NavLink href="/dashboard">+ New graph</NavLink>
      <NavLink href="/runs">Runs</NavLink>
      <NavLink href="/templates">Templates</NavLink>
      <span style={{ flex: 1 }} />
      <ThemeToggle />
      {!loading && (user ? (
        <>
          <NavLink href="/settings">Settings</NavLink>
          <span style={{ color: "var(--text-muted)", fontSize: 14 }}>{user.email}</span>
          <button onClick={logout} style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}>
            Log out
          </button>
        </>
      ) : (
        <a href="/login" style={{ textDecoration: "none", padding: "4px 8px", color: "var(--text)" }}>
          Log in
        </a>
      ))}
    </nav>
  );
}
