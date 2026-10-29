ALTER TABLE "import_alert_summary" ADD CONSTRAINT "import_alert_summary_locale_ck" CHECK (locale in ('en', 'ur', 'hi', 'bn'));--> statement-breakpoint
ALTER TABLE "import_alert_summary" ADD CONSTRAINT "import_alert_summary_status_ck" CHECK (status in ('draft', 'approved', 'rejected', 'machine'));--> statement-breakpoint
ALTER TABLE "import_alert_summary" ADD CONSTRAINT "import_alert_summary_reviewed_ck" CHECK (status <> 'approved' or reviewed_at is not null);--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_prefix_ck" CHECK (left(prefix, 8) = 'rr_live_');