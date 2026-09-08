"use client";

import { useEffect, useState } from "react";
import { createRun, fetchRun, listRuns, type GraphSummary, type Run } from "./api";

/** A run's `input` holds the FULL transcript so far; this recovers just this turn's message. */
export function extractLatestUserMessage(transcript: string): string {
  const idx = transcript.lastIndexOf("User: ");
  return idx === -1 ? transcript : transcript.slice(idx + "User: ".length);
}

/** Chains each completed run's own transcript forward — no backend/schema change needed. */
export function buildNextInput(lastCompletedRun: Run | null, newMessage: string): string {
  if (!lastCompletedRun || typeof lastCompletedRun.input !== "string") return `User: ${newMessage}`;
  return `${lastCompletedRun.input}\nAssistant: ${lastCompletedRun.output}\nUser: ${newMessage}`;
}

/**
 * Shared send/history/multi-turn-memory logic behind the Dashboard's chat
 * surfaces — originally single-node "bot" graphs only (BotChat), now also
 * used by multi-node graphs via HierarchyChat so a "team" gets the same
 * conversation continuity a single bot already had.
 */
export function useBotChat(graph: GraphSummary) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadHistory() {
    const rows = await listRuns(graph.id);
    const chronological = rows
      .filter((r) => r.status === "completed")
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    setRuns(chronological);
  }

  useEffect(() => {
    loadHistory().catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.id]);

  async function send() {
    if (!input.trim()) return;
    const message = input;
    setInput("");
    setSending(true);
    setError(null);
    try {
      const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
      const nextInput = buildNextInput(lastRun, message);
      const created = await createRun(graph.id, nextInput);

      let final = await fetchRun(created.id);
      for (let i = 0; i < 30 && final.status !== "completed" && final.status !== "error"; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        final = await fetchRun(created.id);
      }
      if (final.status === "error") throw new Error("The bot failed to respond — check its Hierarchy/Runs view for details");
      setRuns((r) => [...r, final]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  return { runs, input, setInput, sending, error, send };
}
