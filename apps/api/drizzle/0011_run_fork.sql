ALTER TABLE "runs" ADD COLUMN "forked_from_run_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "forked_from_sequence" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_forked_from_run_id_runs_id_fk" FOREIGN KEY ("forked_from_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
