CREATE TABLE "scheduled_triggers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"graph_id" uuid NOT NULL,
	"created_by" uuid,
	"name" text NOT NULL,
	"input" jsonb NOT NULL,
	"mode" text DEFAULT 'pinned' NOT NULL,
	"cron_expression" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_id" uuid,
	"last_triggered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_triggers" ADD CONSTRAINT "scheduled_triggers_graph_id_agent_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."agent_graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_triggers" ADD CONSTRAINT "scheduled_triggers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;