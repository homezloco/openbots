ALTER TABLE "agent_nodes" ADD COLUMN "dispatch_targets" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "dispatch_depth" integer DEFAULT 0 NOT NULL;