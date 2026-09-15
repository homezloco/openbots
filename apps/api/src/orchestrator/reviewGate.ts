import { startsWithSentinel } from "./resolve.js";

/**
 * Reviewer gate: a `reviewer`-role node reached via an explicit edge is a
 * quality gate on the previous hop's output, not a new author. Before
 * this existed, a Specialist → Quality Reviewer pipeline delivered the
 * reviewer's VERDICT ("Approved – the specialist's response is clear…")
 * as the run's answer, and the actual answer only survived in hop #1's
 * run_event. Worse, useBotChat then chained that verdict into the next
 * turn as the assistant's own prior message, so every later turn was
 * "remembering" a critique instead of an answer. Found in real use on a
 * generated 8-agent pipeline.
 *
 * The gate keeps the reviewed content as the deliverable and attaches
 * the verdict to it. What the verdict changes is only how much of the
 * reviewer's text rides along: an approval becomes a one-line note (the
 * full review is still in the hop's run_event), anything else is
 * appended in full so the user sees both the answer and what's wrong
 * with it. There is no outcome where the content is dropped.
 *
 * A reviewer reached via an AUTO edge (a router sending the user's own
 * request to a "Reviewer (risk, correctness)" specialist, as in the
 * example graphs) is being asked directly — its output IS the answer —
 * so the gate never applies there; engine.ts decides by checking that
 * the reviewer's input is exactly the previous hop's output. Consensus
 * aggregators never reach this code either (their hop completes on the
 * aggregator path before routing).
 */

export type ReviewVerdict = "approved" | "needs_revision" | "unknown";

/**
 * The sentinels appendReviewGateContext teaches — the same first-token
 * convention as UNKNOWN / ALL / DONE, parsed by the same
 * startsWithSentinel. Underscore form so it survives as one token.
 */
export const APPROVED_SENTINEL = "APPROVED";
export const NEEDS_REVISION_SENTINEL = "NEEDS_REVISION";

// Sentinel compliance can't be relied on (the trailing-? rule in
// resolve.ts exists for exactly this reason), so a verdict line is also
// read the way a human would. Ordered by POSITION, not by which regex
// matches at all: "**Approved** – … No revisions are needed." must read
// as approved even though "revisions" appears later in the same line,
// and "Not approved" must read as negative even though "approved" is in
// it. Whichever phrase appears first in the line wins.
const POSITIVE = /\b(approved?|lgtm|looks good|pass(?:es|ed)?|accept(?:ed)?)\b/i;
const NEGATIVE =
  /\b(not approved|needs? (?:revisions?|work|changes?|fixes)|changes? requested|revis(?:e|ion)|reject(?:ed)?|fail(?:ed|s)?|unapproved|blocked|do not (?:approve|ship|send))\b/i;

/** Strip markdown emphasis/headings/list bullets and status emoji so the verdict words are what's left. */
function plainLine(line: string): string {
  return line.replace(/[*_#>`~\-–—•]|✅|❌|⚠️|🚫|✔️|✓|✗/g, " ").replace(/\s+/g, " ").trim();
}

function classifyLine(line: string): ReviewVerdict {
  const text = plainLine(line);
  if (!text) return "unknown";
  const pos = text.search(POSITIVE);
  const neg = text.search(NEGATIVE);
  if (pos === -1 && neg === -1) return "unknown";
  if (neg === -1) return "approved";
  if (pos === -1) return "needs_revision";
  return neg <= pos ? "needs_revision" : "approved";
}

/**
 * Sentinel first, then the first non-empty line, then the last one —
 * reviewers that write prose first usually close with "Overall: Approved."
 * "unknown" is the safe outcome: the content still goes through, with
 * the whole review attached.
 */
export function parseReviewVerdict(output: unknown): ReviewVerdict {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  if (startsWithSentinel(text, APPROVED_SENTINEL)) return "approved";
  if (startsWithSentinel(text, NEEDS_REVISION_SENTINEL)) return "needs_revision";
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "unknown";
  const first = classifyLine(lines[0]);
  if (first !== "unknown") return first;
  return lines.length > 1 ? classifyLine(lines[lines.length - 1]) : "unknown";
}

/** The reviewer's own text minus a leading sentinel line, for the approval note. */
function reviewerNotes(output: string): string {
  return output
    .replace(new RegExp(`^\\s*(?:${APPROVED_SENTINEL}|${NEEDS_REVISION_SENTINEL})[\\s,.:;!\\-–—]*`, "i"), "")
    .trim();
}

/**
 * The run's deliverable when a reviewer gate ends (or hands off) a run.
 * `reviewedContent` is the previous hop's output verbatim; `reviewerOutput`
 * is what the reviewer said about it.
 */
export function applyReviewGate(reviewerName: string, reviewedContent: string, reviewerOutput: string): string {
  const verdict = parseReviewVerdict(reviewerOutput);
  if (verdict === "approved") {
    const notes = reviewerNotes(reviewerOutput);
    // Keep the note short: an approval's "why it passes" table is noise in
    // front of the answer, and stays readable in the run trail anyway.
    const brief = notes && notes.length <= 300 && !notes.includes("\n") ? ` ${notes}` : "";
    return `${reviewedContent}\n\n---\n✅ Reviewed by ${reviewerName}: approved.${brief}`;
  }
  return `${reviewedContent}\n\n---\n⚠️ ${reviewerName} flagged issues with this answer:\n\n${reviewerOutput.trim()}`;
}

/**
 * Injected into a reviewer's system prompt only when the gate applies
 * (engine.ts knows at dispatch time whether this hop's input is the
 * previous hop's output). Mirrors appendAutoRoutingContext's approach:
 * teach the convention every time rather than trusting hand-written
 * prompts to know it. Explicitly tells the model NOT to re-emit the
 * content — a reviewer that "approves" by pasting the answer back
 * doubles output tokens per turn for nothing (this pipeline was already
 * dying on a provider TPM limit).
 */
export function appendReviewGateContext(systemPrompt: string, isReviewGate: boolean): string {
  if (!isReviewGate) return systemPrompt;
  return `${systemPrompt}\n\nYou are reviewing another agent's response before it goes to the user. The response you are reviewing is what the user will receive; your review is attached to it as a note, not shown instead of it. Start your reply with exactly one word on its own line: ${APPROVED_SENTINEL} if the response can go to the user as-is (you may follow with one brief line of notes), or ${NEEDS_REVISION_SENTINEL} followed by the specific problems. Do not rewrite, repeat, or summarize the response itself.`;
}
