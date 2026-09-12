CREATE TABLE "sandbox_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"graph_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"language" text NOT NULL,
	"code" text NOT NULL,
	"exit_code" integer,
	"output" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_graph_id_agent_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."agent_graphs"("id") ON DELETE cascade ON UPDATE no action;