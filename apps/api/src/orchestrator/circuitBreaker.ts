/**
 * Per-hop isolation: every node dispatch gets its own timeout and never
 * shares failure state with other nodes or other runs. Directly addresses
 * the "shared-computer fragility" gap found in Grok Bot, where one stuck
 * bot could take down the whole roster — here a hung node fails only its
 * own hop; the BullMQ worker pool keeps other runs/nodes unaffected.
 */
export class NodeTimeoutError extends Error {
  constructor(nodeId: string, timeoutMs: number) {
    super(`Node ${nodeId} exceeded ${timeoutMs}ms timeout`);
    this.name = "NodeTimeoutError";
  }
}

// 180s, not 90s: raising the tool-call step cap (engine.ts's
// stepCountIs, 8 -> 20) only helps a real multi-file investigate-then-edit
// task if there's also enough wall-clock time to spend those steps —
// found by direct measurement after that change, where every branch of a
// real consensus fan-out ran the full 90s and still got cut off before
// finishing, worse than before (a total wipeout instead of a partial
// success). The two caps have to move together.
export const DEFAULT_NODE_TIMEOUT_MS = 180_000;

export async function withNodeTimeout<T>(
  nodeId: string,
  task: () => Promise<T>,
  timeoutMs: number = DEFAULT_NODE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NodeTimeoutError(nodeId, timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([task(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
