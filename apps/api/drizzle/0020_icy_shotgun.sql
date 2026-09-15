CREATE INDEX "agent_commits_graph_id_idx" ON "agent_commits" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "agent_commits_run_id_idx" ON "agent_commits" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_nodes_graph_id_idx" ON "agent_nodes" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "routing_changes_graph_id_idx" ON "routing_changes" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "routing_edges_graph_id_idx" ON "routing_edges" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "run_events_run_id_idx" ON "run_events" USING btree ("run_id");--> statement-breakpoint
-- Hand-added before the unique index: any deployment that ever hit the
-- nextSequence() race this index closes already HAS duplicate
-- (run_id, sequence) rows (typically a succeeded + cancelled pair from a
-- /cancel landing mid-hop), and CREATE UNIQUE INDEX fails on them — the
-- api then can't boot at all, since migrations run on startup. Keep the
-- most informative row per pair (succeeded > failed > anything else, then
-- latest finished) and drop the rest. Drizzle applies migrations by
-- journal timestamp, not file hash, so editing this file is a no-op for
-- deployments that already applied it cleanly.
DELETE FROM "run_events" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "run_id", "sequence"
      ORDER BY CASE "status" WHEN 'succeeded' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
               "finished_at" DESC NULLS LAST, "id"
    ) AS rn
    FROM "run_events"
  ) ranked WHERE rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_id_sequence_unique" ON "run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "runs_graph_id_idx" ON "runs" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "scheduled_triggers_graph_id_idx" ON "scheduled_triggers" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "usage_events_run_id_idx" ON "usage_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "webhook_triggers_graph_id_idx" ON "webhook_triggers" USING btree ("graph_id");