CREATE TABLE "webhook_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"created_by" uuid,
	"name" text NOT NULL,
	"mode" text DEFAULT 'pinned' NOT NULL,
	"token_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_id" uuid,
	"last_triggered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_triggers_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "webhook_trigger_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_graph_id_agent_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."agent_graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_webhook_trigger_id_webhook_triggers_id_fk" FOREIGN KEY ("webhook_trigger_id") REFERENCES "public"."webhook_triggers"("id") ON DELETE set null ON UPDATE no action;