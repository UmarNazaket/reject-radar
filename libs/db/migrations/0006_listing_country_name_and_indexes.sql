ALTER TABLE "import_alert_listing" ADD COLUMN "country_name" text;--> statement-breakpoint
CREATE INDEX "change_event_notice_idx" ON "change_event" USING btree ("notice_id");--> statement-breakpoint
CREATE INDEX "notice_url_idx" ON "notice" USING btree ("url");