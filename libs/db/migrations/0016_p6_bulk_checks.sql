DROP INDEX "bulk_job_row_job_row_idx";--> statement-breakpoint
ALTER TABLE "bulk_job" ADD COLUMN "delimiter" text DEFAULT ',' NOT NULL;--> statement-breakpoint
ALTER TABLE "bulk_job_row" ADD COLUMN "attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "bulk_job_active_idx" ON "bulk_job" USING btree ("status") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "bulk_job_finished_idx" ON "bulk_job" USING btree ("finished_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_job_row_job_row_idx" ON "bulk_job_row" USING btree ("job_id","row_nr");--> statement-breakpoint
ALTER TABLE "bulk_job" ADD CONSTRAINT "bulk_job_status_ck" CHECK (status in ('queued', 'running', 'finished'));--> statement-breakpoint
ALTER TABLE "bulk_job" ADD CONSTRAINT "bulk_job_delimiter_ck" CHECK (delimiter in (',', chr(59)));--> statement-breakpoint
ALTER TABLE "bulk_job_row" ADD CONSTRAINT "bulk_job_row_status_ck" CHECK (status in ('pending', 'matched', 'review', 'no_record', 'confirmed', 'rejected'));