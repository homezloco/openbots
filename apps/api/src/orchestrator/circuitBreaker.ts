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

const DEFAULT_NODE_TIMEOUT_MS = 60_000;

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
