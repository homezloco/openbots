CREATE TABLE "agent_graphs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"entry_node_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position_x" real DEFAULT 0 NOT NULL,
	"position_y" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"change_type" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"graph_version" integer NOT NULL,
	"changed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"source_node_id" uuid NOT NULL,
	"target_node_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"condition" text DEFAULT 'default' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"resolved_edge_id" uuid,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"graph_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"graph_snapshot" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_node_id" uuid,
	"input" jsonb,
	"output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_nodes" ADD CONSTRAINT "agent_nodes_graph_id_agent_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."agent_graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_changes" ADD CONSTRAINT "routing_changes_graph_id_agent_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."agent_graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_edges" ADD CONSTRAINT "routing_edges_graph_id_agent_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."agent_graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_edges" ADD CONSTRAINT "routing_edges_source_node_id_agent_nodes_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "public"."agent_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_edges" ADD CONSTRAINT "routing_edges_target_node_id_agent_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."agent_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_graph_id_agent_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."agent_graphs"("id") ON DELETE cascade ON UPDATE no action;