"use client";

import { useAuth } from "./AuthProvider";
import { ThemeToggle } from "./ThemeToggle";

export function NavBar() {
  const { user, loading, logout } = useAuth();

  return (
    <nav style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 24px", borderBottom: "1px solid var(--border)" }}>
      <strong>OpenBots</strong>
      <a href="/dashboard">Dashboard</a>
      <a href="/hierarchy">Hierarchy</a>
      <a href="/graphs/new">New graph</a>
      <a href="/runs">Runs</a>
      <a href="/templates">Templates</a>
      <span style={{ flex: 1 }} />
      <ThemeToggle />
      {!loading && (user ? (
        <>
          <span>{user.email}</span>
          <button onClick={logout}>Log out</button>
        </>
      ) : (
        <a href="/login">Log in</a>
      ))}
    </nav>
  );
}
