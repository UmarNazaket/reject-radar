CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "au_failing_food" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "au_failing_food_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_key" text NOT NULL,
	"report_month" date NOT NULL,
	"failed_on" date,
	"product_desc" text NOT NULL,
	"country_code" text,
	"producer_name" text,
	"name_norm" text DEFAULT '' NOT NULL,
	"test_applied" text,
	"reason" text,
	"result_text" text,
	"holding_order_match" boolean,
	"scheme" text,
	"commodity_id" integer,
	"hazard_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"firm_id" bigint,
	"link_score" numeric(5, 4)
);
--> statement-breakpoint
CREATE TABLE "change_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "change_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"occurred_on" date NOT NULL,
	"firm_id" bigint,
	"requires_firm" boolean DEFAULT false NOT NULL,
	"origin_country" text,
	"commodity_id" integer,
	"destination" text,
	"hazard_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"notice_id" bigint,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commodity" (
	"id" integer PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" integer,
	"ancestor_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"hs_headings" text[] DEFAULT '{}'::text[] NOT NULL,
	"eu_mrl_codes" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commodity_rule" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "commodity_rule_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"field" text NOT NULL,
	"match_type" text NOT NULL,
	"pattern" text NOT NULL,
	"commodity_id" integer NOT NULL,
	"priority" smallint DEFAULT 100 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eu_mrl" (
	"product_code" text NOT NULL,
	"residue_id" text NOT NULL,
	"mrl_mg_kg" numeric(12, 4),
	"is_lod" boolean DEFAULT false NOT NULL,
	"legal_ref" text,
	"applicable_from" date,
	CONSTRAINT "eu_mrl_product_code_residue_id_pk" PRIMARY KEY("product_code","residue_id")
);
--> statement-breakpoint
CREATE TABLE "eu_mrl_product" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_code" text
);
--> statement-breakpoint
CREATE TABLE "eu_pesticide_residue" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_norm" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fda_charge_code" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text,
	"section" text,
	"description" text,
	"hazard_id" integer
);
--> statement-breakpoint
CREATE TABLE "fda_refusal" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fda_refusal_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_key" text NOT NULL,
	"fei" bigint,
	"firm_name" text NOT NULL,
	"name_norm" text NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country_code" text,
	"division_code" text,
	"industry_code" text,
	"product_code" text,
	"product_desc" text,
	"product_category" text,
	"refusal_date" date NOT NULL,
	"charge_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"fda_sample_analysis" boolean,
	"private_lab_analysis" boolean,
	"commodity_id" integer,
	"hazard_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"firm_id" bigint,
	"link_score" numeric(5, 4)
);
--> statement-breakpoint
CREATE TABLE "firm" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "firm_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"display_name" text NOT NULL,
	"name_norm" text NOT NULL,
	"alt_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"country_code" text,
	"region" text,
	"city" text,
	"postal_code" text,
	"address_norm" text,
	"commodity_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"first_seen" date,
	"last_notice_on" date,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firm_alias" (
	"old_id" bigint PRIMARY KEY NOT NULL,
	"new_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firm_fei" (
	"fei" bigint PRIMARY KEY NOT NULL,
	"firm_id" bigint NOT NULL,
	"first_seen" date
);
--> statement-breakpoint
CREATE TABLE "hazard" (
	"id" integer PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hazard_rule" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "hazard_rule_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"field" text NOT NULL,
	"match_type" text NOT NULL,
	"pattern" text NOT NULL,
	"hazard_id" integer NOT NULL,
	"priority" smallint DEFAULT 100 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_alert" (
	"number" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"alert_type" text,
	"published_on" date,
	"is_food" boolean DEFAULT false NOT NULL,
	"reason_text" text,
	"guidance_text" text,
	"product_text" text,
	"charge_text" text,
	"text_sha256" text NOT NULL,
	"url" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_alert_listing" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "import_alert_listing_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"listing_key" text NOT NULL,
	"alert_number" text NOT NULL,
	"list" text NOT NULL,
	"firm_name" text NOT NULL,
	"name_norm" text NOT NULL,
	"address_raw" text,
	"city" text,
	"region" text,
	"country_code" text,
	"listed_on" date,
	"first_seen_on" date NOT NULL,
	"last_seen_on" date NOT NULL,
	"missed_runs" smallint DEFAULT 0 NOT NULL,
	"removed_on" date,
	"firm_id" bigint,
	"link_score" numeric(5, 4)
);
--> statement-breakpoint
CREATE TABLE "import_alert_listing_product" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "import_alert_listing_product_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"listing_id" bigint NOT NULL,
	"product_code" text,
	"product_name" text,
	"description" text,
	"listed_on" date,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "import_alert_summary" (
	"alert_number" text NOT NULL,
	"locale" text NOT NULL,
	"content" jsonb NOT NULL,
	"source_sha256" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_alert_summary_alert_number_locale_pk" PRIMARY KEY("alert_number","locale")
);
--> statement-breakpoint
CREATE TABLE "job_cursor" (
	"name" text PRIMARY KEY NOT NULL,
	"last_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_review" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "match_review_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"firm_id" bigint NOT NULL,
	"candidate_firm_id" bigint NOT NULL,
	"score" numeric(5, 4) NOT NULL,
	"reason" text DEFAULT 'score_band' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notice" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notice_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"destination" text NOT NULL,
	"notice_type" text NOT NULL,
	"notice_on" date NOT NULL,
	"origin_country" text,
	"commodity_id" integer,
	"hazard_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"product_text" text,
	"firm_name" text,
	"firm_id" bigint,
	"title" text,
	"url" text
);
--> statement-breakpoint
CREATE TABLE "rasff_notification" (
	"reference" text PRIMARY KEY NOT NULL,
	"notified_on" date NOT NULL,
	"classification" text,
	"risk_decision" text,
	"notifying_country" text,
	"origin_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"distribution_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"product_category" text,
	"subject" text NOT NULL,
	"hazards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commodity_id" integer,
	"hazard_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"url" text
);
--> statement-breakpoint
CREATE TABLE "source_sync_run" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_sync_run_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"origin" text,
	"content_sha256" text,
	"rows_read" integer DEFAULT 0 NOT NULL,
	"rows_inserted" integer DEFAULT 0 NOT NULL,
	"rows_updated" integer DEFAULT 0 NOT NULL,
	"rows_deleted" integer DEFAULT 0 NOT NULL,
	"events_emitted" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "uk_border_notification" (
	"source_key" text PRIMARY KEY NOT NULL,
	"notified_on" date NOT NULL,
	"origin_country" text,
	"commodity" text,
	"product_category" text,
	"product_name" text,
	"hazard_category" text,
	"failure_type" text,
	"reason" text,
	"consignment_type" text,
	"legislation_controlled" text,
	"commodity_id" integer,
	"hazard_ids" integer[] DEFAULT '{}'::int[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"change_event_id" bigint NOT NULL,
	"firm_id" bigint,
	"severity" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"failed_logins" smallint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bulk_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" uuid,
	"file_name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bulk_job_row" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bulk_job_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" uuid NOT NULL,
	"row_nr" integer NOT NULL,
	"input_name" text NOT NULL,
	"input_country" text,
	"input_city" text,
	"input_fei" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"firm_id" bigint,
	"score" numeric(5, 4),
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"firm_id" bigint NOT NULL,
	"source" text,
	"source_key" text,
	"kind" text DEFAULT 'other' NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_delivery" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"to_email" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"provider_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lookup_log" (
	"org_id" uuid NOT NULL,
	"firm_id" bigint NOT NULL,
	"period" text NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lookup_log_org_id_firm_id_period_pk" PRIMARY KEY("org_id","firm_id","period")
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_pref" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"instant_high" boolean DEFAULT true NOT NULL,
	"digest" text DEFAULT 'daily' NOT NULL,
	"last_digest_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan_override" text,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paddle_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "refresh_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"paddle_customer_id" text,
	"paddle_subscription_id" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"interval" text,
	"status" text NOT NULL,
	"current_period_end" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counter" (
	"org_id" uuid NOT NULL,
	"period" text NOT NULL,
	"lookups" integer DEFAULT 0 NOT NULL,
	"bulk_rows" integer DEFAULT 0 NOT NULL,
	"api_calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_counter_org_id_period_pk" PRIMARY KEY("org_id","period")
);
--> statement-breakpoint
CREATE TABLE "watchlist_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"firm_id" bigint,
	"origin_country" text,
	"commodity_id" integer,
	"destination" text,
	"hazard_id" integer,
	"topic_key" text,
	"input_name" text,
	"label" text,
	"notes" text,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_item_kind_ck" CHECK ((kind = 'firm' and firm_id is not null and topic_key is null) or (kind = 'topic' and firm_id is null and topic_key is not null and origin_country is not null))
);
--> statement-breakpoint
ALTER TABLE "au_failing_food" ADD CONSTRAINT "au_failing_food_commodity_id_commodity_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."commodity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "au_failing_food" ADD CONSTRAINT "au_failing_food_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_event" ADD CONSTRAINT "change_event_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_event" ADD CONSTRAINT "change_event_commodity_id_commodity_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."commodity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_event" ADD CONSTRAINT "change_event_notice_id_notice_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commodity" ADD CONSTRAINT "commodity_parent_id_commodity_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."commodity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commodity_rule" ADD CONSTRAINT "commodity_rule_commodity_id_commodity_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."commodity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eu_mrl" ADD CONSTRAINT "eu_mrl_product_code_eu_mrl_product_code_fk" FOREIGN KEY ("product_code") REFERENCES "public"."eu_mrl_product"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eu_mrl" ADD CONSTRAINT "eu_mrl_residue_id_eu_pesticide_residue_id_fk" FOREIGN KEY ("residue_id") REFERENCES "public"."eu_pesticide_residue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fda_charge_code" ADD CONSTRAINT "fda_charge_code_hazard_id_hazard_id_fk" FOREIGN KEY ("hazard_id") REFERENCES "public"."hazard"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fda_refusal" ADD CONSTRAINT "fda_refusal_commodity_id_commodity_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."commodity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fda_refusal" ADD CONSTRAINT "fda_refusal_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_alias" ADD CONSTRAINT "firm_alias_new_id_firm_id_fk" FOREIGN KEY ("new_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_fei" ADD CONSTRAINT "firm_fei_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hazard_rule" ADD CONSTRAINT "hazard_rule_hazard_id_hazard_id_fk" FOREIGN KEY ("hazard_id") REFERENCES "public"."hazard"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_alert_listing" ADD CONSTRAINT "import_alert_listing_alert_number_import_alert_number_fk" FOREIGN KEY ("alert_number") REFERENCES "public"."import_alert"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_alert_listing" ADD CONSTRAINT "import_alert_listing_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_alert_listing_product" ADD CONSTRAINT "import_alert_listing_product_listing_id_import_alert_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."import_alert_listing"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_alert_summary" ADD CONSTRAINT "import_alert_summary_alert_number_import_alert_number_fk" FOREIGN KEY ("alert_number") REFERENCES "public"."import_alert"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_review" ADD CONSTRAINT "match_review_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_review" ADD CONSTRAINT "match_review_candidate_firm_id_firm_id_fk" FOREIGN KEY ("candidate_firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_commodity_id_commodity_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."commodity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rasff_notification" ADD CONSTRAINT "rasff_notification_commodity_id_commodity_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."commodity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uk_border_notification" ADD CONSTRAINT "uk_border_notification_commodity_id_commodity_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."commodity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_change_event_id_change_event_id_fk" FOREIGN KEY ("change_event_id") REFERENCES "public"."change_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_job" ADD CONSTRAINT "bulk_job_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_job" ADD CONSTRAINT "bulk_job_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_job_row" ADD CONSTRAINT "bulk_job_row_job_id_bulk_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."bulk_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_job_row" ADD CONSTRAINT "bulk_job_row_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD CONSTRAINT "email_delivery_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_token" ADD CONSTRAINT "email_token_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_invited_by_app_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookup_log" ADD CONSTRAINT "lookup_log_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookup_log" ADD CONSTRAINT "lookup_log_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_pref" ADD CONSTRAINT "notification_pref_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counter" ADD CONSTRAINT "usage_counter_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_item" ADD CONSTRAINT "watchlist_item_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_item" ADD CONSTRAINT "watchlist_item_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firm"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_item" ADD CONSTRAINT "watchlist_item_commodity_id_commodity_id_fk" FOREIGN KEY ("commodity_id") REFERENCES "public"."commodity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_item" ADD CONSTRAINT "watchlist_item_hazard_id_hazard_id_fk" FOREIGN KEY ("hazard_id") REFERENCES "public"."hazard"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_item" ADD CONSTRAINT "watchlist_item_added_by_app_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "au_failing_food_source_key_uq" ON "au_failing_food" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "au_failing_food_name_trgm_idx" ON "au_failing_food" USING gin ("name_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "au_failing_food_firm_idx" ON "au_failing_food" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "au_failing_food_failed_on_idx" ON "au_failing_food" USING btree ("failed_on");--> statement-breakpoint
CREATE INDEX "change_event_firm_idx" ON "change_event" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "change_event_source_key_idx" ON "change_event" USING btree ("source","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "commodity_slug_uq" ON "commodity" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "commodity_rule_source_idx" ON "commodity_rule" USING btree ("source","field");--> statement-breakpoint
CREATE INDEX "eu_mrl_residue_idx" ON "eu_mrl" USING btree ("residue_id");--> statement-breakpoint
CREATE INDEX "eu_pesticide_residue_name_trgm_idx" ON "eu_pesticide_residue" USING gin ("name_norm" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "fda_refusal_source_key_uq" ON "fda_refusal" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "fda_refusal_name_trgm_idx" ON "fda_refusal" USING gin ("name_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "fda_refusal_firm_idx" ON "fda_refusal" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "fda_refusal_fei_idx" ON "fda_refusal" USING btree ("fei");--> statement-breakpoint
CREATE INDEX "fda_refusal_date_idx" ON "fda_refusal" USING btree ("refusal_date");--> statement-breakpoint
CREATE INDEX "firm_name_norm_trgm_idx" ON "firm" USING gin ("name_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "firm_country_idx" ON "firm" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "firm_fei_firm_idx" ON "firm_fei" USING btree ("firm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hazard_slug_uq" ON "hazard" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "hazard_rule_source_idx" ON "hazard_rule" USING btree ("source","field");--> statement-breakpoint
CREATE UNIQUE INDEX "import_alert_listing_key_uq" ON "import_alert_listing" USING btree ("listing_key");--> statement-breakpoint
CREATE INDEX "import_alert_listing_name_trgm_idx" ON "import_alert_listing" USING gin ("name_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "import_alert_listing_firm_idx" ON "import_alert_listing" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "import_alert_listing_alert_idx" ON "import_alert_listing" USING btree ("alert_number");--> statement-breakpoint
CREATE INDEX "import_alert_listing_product_listing_idx" ON "import_alert_listing_product" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "match_review_status_idx" ON "match_review" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "notice_source_key_uq" ON "notice" USING btree ("source","source_key");--> statement-breakpoint
CREATE INDEX "notice_destination_date_idx" ON "notice" USING btree ("destination","notice_on");--> statement-breakpoint
CREATE INDEX "notice_origin_commodity_date_idx" ON "notice" USING btree ("origin_country","commodity_id","notice_on");--> statement-breakpoint
CREATE INDEX "notice_firm_idx" ON "notice" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "notice_hazard_ids_idx" ON "notice" USING gin ("hazard_ids");--> statement-breakpoint
CREATE INDEX "notice_product_trgm_idx" ON "notice" USING gin ("product_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "rasff_notification_notified_on_idx" ON "rasff_notification" USING btree ("notified_on");--> statement-breakpoint
CREATE INDEX "source_sync_run_source_started_idx" ON "source_sync_run" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "uk_border_notification_notified_on_idx" ON "uk_border_notification" USING btree ("notified_on");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_org_event_uq" ON "alert" USING btree ("org_id","change_event_id");--> statement-breakpoint
CREATE INDEX "alert_org_created_idx" ON "alert" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_hash_uq" ON "api_key" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_key_org_idx" ON "api_key" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_lower_uq" ON "app_user" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bulk_job_org_idx" ON "bulk_job" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "bulk_job_row_job_row_idx" ON "bulk_job_row" USING btree ("job_id","row_nr");--> statement-breakpoint
CREATE INDEX "bulk_job_row_job_status_idx" ON "bulk_job_row" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "dispute_status_idx" ON "dispute" USING btree ("status");--> statement-breakpoint
CREATE INDEX "dispute_org_idx" ON "dispute" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "email_delivery_created_idx" ON "email_delivery" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_token_hash_uq" ON "email_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "email_token_user_idx" ON "email_token" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_token_hash_uq" ON "invite" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invite_org_idx" ON "invite" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "membership_user_idx" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_token_hash_uq" ON "refresh_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_token_user_idx" ON "refresh_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_token_family_idx" ON "refresh_token" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_paddle_sub_uq" ON "subscription" USING btree ("paddle_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_item_org_firm_uq" ON "watchlist_item" USING btree ("org_id","firm_id") WHERE kind = 'firm';--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_item_org_topic_uq" ON "watchlist_item" USING btree ("org_id","topic_key") WHERE kind = 'topic';--> statement-breakpoint
CREATE INDEX "watchlist_item_org_idx" ON "watchlist_item" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "watchlist_item_firm_idx" ON "watchlist_item" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "watchlist_item_topic_idx" ON "watchlist_item" USING btree ("origin_country","commodity_id");