CREATE INDEX "agent_commits_graph_id_idx" ON "agent_commits" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "agent_commits_run_id_idx" ON "agent_commits" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_nodes_graph_id_idx" ON "agent_nodes" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "routing_changes_graph_id_idx" ON "routing_changes" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "routing_edges_graph_id_idx" ON "routing_edges" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "run_events_run_id_idx" ON "run_events" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_id_sequence_unique" ON "run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "runs_graph_id_idx" ON "runs" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "scheduled_triggers_graph_id_idx" ON "scheduled_triggers" USING btree ("graph_id");--> statement-breakpoint
CREATE INDEX "usage_events_run_id_idx" ON "usage_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "webhook_triggers_graph_id_idx" ON "webhook_triggers" USING btree ("graph_id");