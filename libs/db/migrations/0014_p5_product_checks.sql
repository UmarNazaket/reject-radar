CREATE TABLE "alert_email" (
	"alert_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_email_alert_id_user_id_pk" PRIMARY KEY("alert_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "alert_email" ADD CONSTRAINT "alert_email_alert_id_alert_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alert"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_email" ADD CONSTRAINT "alert_email_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_severity_ck" CHECK (severity in ('high', 'normal'));--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_kind_ck" CHECK (kind in ('wrong_firm', 'mixed_firms', 'wrong_details', 'other'));--> statement-breakpoint
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_status_ck" CHECK (status in ('open', 'rejected', 'resolved'));--> statement-breakpoint
ALTER TABLE "notification_pref" ADD CONSTRAINT "notification_pref_digest_ck" CHECK (digest in ('daily', 'weekly', 'off'));--> statement-breakpoint
ALTER TABLE "org" ADD CONSTRAINT "org_plan_override_ck" CHECK (plan_override in ('free', 'pro', 'business', 'enterprise'));--> statement-breakpoint
ALTER TABLE "watchlist_item" ADD CONSTRAINT "watchlist_item_destination_ck" CHECK (destination in ('US', 'EU', 'UK', 'AU'));