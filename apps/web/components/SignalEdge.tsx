import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

export interface EdgePulse {
  id: string;
  edgeId: string;
}

/**
 * A one-shot "signal traveling" pulse rendered on top of the normal edge
 * path whenever a hop resolves to it. Each pulse is its own freshly-mounted
 * <circle> (keyed by a unique id, removed from state after it finishes) —
 * mounting a new element per pulse means every one starts its own SMIL
 * animation from scratch, so two consecutive hops down the same edge just
 * stack two independent circles with no "restart the animation" trick
 * needed. See HierarchyCanvas.tsx's `pulses` state and `addPulse`.
 */
export function SignalEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const pulses = (data as { pulses?: EdgePulse[] } | undefined)?.pulses ?? [];

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      {pulses.map((p) => (
        <circle key={p.id} r={4} fill="var(--status-running)">
          <animateMotion dur="0.6s" repeatCount={1} path={edgePath} />
        </circle>
      ))}
    </>
  );
}
