/**
 * The orchestration engine teaches supervisor/auto-routing nodes a
 * free-text sentinel convention (DONE / UNKNOWN / ALL as a leading token —
 * see `resolve.ts::startsWithSentinel` and CLAUDE.md's "Auto-routing needs
 * to be told its own candidates" section) so a node's own output can
 * double as a routing signal. That's an engine-internal convention, not
 * something a real user should ever see literally prefixed onto an
 * answer they're reading as chat/answer text — a genuine, reported bug.
 *
 * This is strictly a DISPLAY-layer fix: it must never be applied to
 * stored run data (`run.input`/`run.output`/`run_events` rows), only to
 * the string handed to JSX right before rendering it as an answer. Never
 * apply it to *inputs* — a user's own message is never sentinel-prefixed
 * by the engine, and stripping there would just mangle their real text.
 */
export function stripRoutingSentinel(text: string): string {
  const match = text.match(/^(DONE|UNKNOWN|ALL)(?=$|[\s:-])/);
  if (!match) return text;
  const rest = text.slice(match[0].length).replace(/^[\s:-]+/, "");
  const trimmed = rest.trim();
  return trimmed === "" ? text : trimmed;
}
