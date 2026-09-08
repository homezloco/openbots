"use client";

import { useEffect, useRef } from "react";
import { runEventsSocketUrl, type RunEventMessage } from "./api";

/**
 * Shared connect/reconnect logic for the graph-scoped run-events socket,
 * used by both the Hierarchy canvas and the run detail page. The DB
 * (runs/run_events) is always the source of truth — a dropped socket just
 * means a temporarily stale live view, never wrong data — so a simple
 * capped exponential backoff is enough; a manual refresh always recovers.
 */
export function useRunEventsSocket(graphId: string | null, onMessage: (msg: RunEventMessage) => void) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!graphId) return;

    let backoff = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let socket: WebSocket | null = null;

    function connect() {
      socket = new WebSocket(runEventsSocketUrl(graphId!));
      socket.onopen = () => {
        backoff = 500;
      };
      socket.onmessage = (event) => {
        try {
          onMessageRef.current(JSON.parse(event.data) as RunEventMessage);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        if (closed) return;
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 8000);
      };
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [graphId]);
}
