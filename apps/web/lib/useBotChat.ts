"use client";

import { useEffect, useState } from "react";
import type { RunStatus } from "@openbots/graph-schema";
import { createRun, fetchRun, listRuns, type GraphSummary, type Run } from "./api";

/** A run's true original input holds the FULL transcript so far; this recovers just this turn's message. */
export function extractLatestUserMessage(transcript: string): string {
  const idx = transcript.lastIndexOf("User: ");
  return idx === -1 ? transcript : transcript.slice(idx + "User: ".length);
}

/**
 * Hard cap on the transcript buildNextInput carries forward, in characters
 * (~4 chars/token as a rough estimate). Without one, a long-running bot's
 * context-window usage and per-turn cost both grow unboundedly — every
 * turn re-sends the ENTIRE prior conversation as one ever-growing string,
 * since that's the only "memory" this hook has (see buildNextInput). A
 * real, previously-shipped bug: nothing bounded this before. 24,000 chars
 * is generous enough for real multi-turn use (dozens of typical exchanges)
 * while staying well inside even a modest local-model context window —
 * "any OpenAI-compatible endpoint including local models via Ollama" means
 * this can't assume a large frontier-model window.
 */
const MAX_TRANSCRIPT_CHARS = 24_000;

/**
 * Trims from the OLDEST end — recency matters most for continuity — at
 * the next "User: " turn boundary at/after the cutoff, so a trim never
 * starts mid-turn. The newest content (including whatever's about to be
 * appended after this runs) is never at risk of being cut, since only
 * the front of the string is ever removed.
 */
function truncateTranscript(transcript: string): string {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  const cutoff = transcript.length - MAX_TRANSCRIPT_CHARS;
  const boundary = transcript.indexOf("\nUser: ", cutoff);
  const trimmed = boundary === -1 ? transcript.slice(cutoff) : transcript.slice(boundary + 1);
  return `[earlier conversation truncated]\n${trimmed}`;
}

/**
 * Chains each completed run's own transcript forward — no backend/schema
 * change needed. Reads `originalInput` (falling back to `input`), NOT
 * `input` directly: for any multi-hop run (including every ALL fan-out),
 * the engine overwrites `runs.input` on each hop transition, so by
 * completion it holds the LAST hop's input rather than the original
 * transcript. `originalInput` (set by GET /graphs/:id/runs from
 * run_events sequence 0) is immune to that.
 */
export function buildNextInput(lastCompletedRun: Run | null, newMessage: string): string {
  const priorTranscript = lastCompletedRun?.originalInput ?? lastCompletedRun?.input;
  if (typeof priorTranscript !== "string") return `User: ${newMessage}`;
  return truncateTranscript(`${priorTranscript}\nAssistant: ${lastCompletedRun!.output}\nUser: ${newMessage}`);
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
  // The in-flight turn, shown immediately on send rather than waiting for
  // the full round trip (including the poll loop below) to resolve — the
  // status here tracks the real backend value (pending -> running ->
  // completed/error) so the UI reflects actual progress, not just a static
  // "Sending…" label.
  const [pending, setPending] = useState<{ message: string; status: RunStatus } | null>(null);

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
    setPending({ message, status: "pending" });
    try {
      const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
      const nextInput = buildNextInput(lastRun, message);
      const created = await createRun(graph.id, nextInput);
      setPending({ message, status: created.status });

      // A real, previously-shipped bug: this used to give up after a fixed
      // 30 iterations (~30s) and fall through UNCONDITIONALLY to setRuns
      // below, treating a still-"running" run (output still null) as if it
      // were the final answer — the chat would then render
      // JSON.stringify(null), literally the text "null", as the bot's
      // reply. Cross-graph tools (business_metrics doing real external
      // HTTP calls per source, dispatch_to_graph chains, multi-step tool
      // use up to engine.ts's stepCountIs(8)) can easily run past 30s, so
      // this became far more likely to hit once those shipped. Now polls
      // for up to POLL_TIMEOUT_MS and never treats a non-"completed"
      // status as success.
      const POLL_TIMEOUT_MS = 10 * 60 * 1000;
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let final = await fetchRun(created.id);
      setPending({ message, status: final.status });
      while (final.status !== "completed" && final.status !== "error" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        final = await fetchRun(created.id);
        setPending({ message, status: final.status });
      }
      if (final.status !== "completed") {
        // A write-capable node can time out/exhaust its step budget AFTER
        // already committing real work to its isolated worktree branch
        // (agent_commits) — don't let that get silently lost behind a
        // generic error message.
        const branches = [...new Set((final.commits ?? []).map((c) => c.branch))];
        const commitNote =
          branches.length > 0
            ? ` Note: the agent committed work to branch${branches.length > 1 ? "es" : ""} ${branches.join(", ")} before failing — see the run page or GitHub panel.`
            : "";
        throw new Error(
          (final.status === "error"
            ? "The bot failed to respond — check its Hierarchy/Runs view for details"
            : "Still running after a long wait — check the graph's Runs page; it may complete in the background.") +
            commitNote,
        );
      }
      // fetchRun (GET /runs/:id) doesn't compute originalInput the way
      // listRuns does — attach it directly since the client already knows
      // exactly what it sent, rather than waiting for a reload to self-correct.
      setRuns((r) => [...r, { ...final, originalInput: nextInput }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setPending(null);
      setSending(false);
    }
  }

  return { runs, input, setInput, sending, error, send, pending };
}
