CREATE TABLE "source_file" (
	"source" text NOT NULL,
	"url" text NOT NULL,
	"sha256" text NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_file_source_url_pk" PRIMARY KEY("source","url"),
	CONSTRAINT "source_file_source_ck" CHECK (source in ('fda_charge_codes', 'fda_refusals', 'import_alerts', 'rasff', 'uk_bn', 'au_ifis', 'eu_mrl'))
);
--> statement-breakpoint
ALTER TABLE "change_event" ADD CONSTRAINT "change_event_source_ck" CHECK (source in ('fda_refusal', 'import_alert', 'rasff', 'uk_bn', 'au_ifis'));--> statement-breakpoint
ALTER TABLE "change_event" ADD CONSTRAINT "change_event_kind_ck" CHECK (kind in ('fda_refusal', 'import_alert_listed', 'import_alert_delisted', 'au_failed_test', 'rasff_notification', 'uk_border_notification'));--> statement-breakpoint
ALTER TABLE "change_event" ADD CONSTRAINT "change_event_severity_ck" CHECK (severity in ('high', 'normal'));--> statement-breakpoint
ALTER TABLE "change_event" ADD CONSTRAINT "change_event_destination_ck" CHECK (destination in ('US', 'EU', 'UK', 'AU'));--> statement-breakpoint
ALTER TABLE "commodity_rule" ADD CONSTRAINT "commodity_rule_source_ck" CHECK (source in ('*', 'fda_refusal', 'import_alert', 'rasff', 'uk_bn', 'au_ifis', 'fda_charge_code'));--> statement-breakpoint
ALTER TABLE "commodity_rule" ADD CONSTRAINT "commodity_rule_match_type_ck" CHECK (match_type in ('code_prefix', 'exact', 'keyword'));--> statement-breakpoint
ALTER TABLE "hazard_rule" ADD CONSTRAINT "hazard_rule_source_ck" CHECK (source in ('*', 'fda_refusal', 'import_alert', 'rasff', 'uk_bn', 'au_ifis', 'fda_charge_code'));--> statement-breakpoint
ALTER TABLE "hazard_rule" ADD CONSTRAINT "hazard_rule_match_type_ck" CHECK (match_type in ('code_prefix', 'exact', 'keyword'));--> statement-breakpoint
ALTER TABLE "import_alert_listing" ADD CONSTRAINT "import_alert_listing_list_ck" CHECK (list in ('red', 'green'));--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_source_ck" CHECK (source in ('fda_refusal', 'import_alert', 'rasff', 'uk_bn', 'au_ifis'));--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_destination_ck" CHECK (destination in ('US', 'EU', 'UK', 'AU'));--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_notice_type_ck" CHECK (notice_type in ('refusal', 'import_alert_listing', 'rasff_alert', 'rasff_border_rejection', 'rasff_information', 'rasff_other', 'uk_border_notification', 'au_failed_test'));--> statement-breakpoint
ALTER TABLE "source_sync_run" ADD CONSTRAINT "source_sync_run_source_ck" CHECK (source in ('fda_charge_codes', 'fda_refusals', 'import_alerts', 'rasff', 'uk_bn', 'au_ifis', 'eu_mrl'));--> statement-breakpoint
ALTER TABLE "source_sync_run" ADD CONSTRAINT "source_sync_run_status_ck" CHECK (status in ('running', 'succeeded', 'failed'));