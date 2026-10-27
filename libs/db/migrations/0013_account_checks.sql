CREATE INDEX "invite_org_email_idx" ON "invite" USING btree ("org_id",lower("email"));--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_locale_ck" CHECK (locale in ('en', 'ur', 'hi', 'bn'));--> statement-breakpoint
ALTER TABLE "email_token" ADD CONSTRAINT "email_token_purpose_ck" CHECK (purpose in ('verify', 'reset'));--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_role_ck" CHECK (role in ('admin', 'member'));--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_role_ck" CHECK (role in ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_plan_ck" CHECK (plan in ('free', 'pro', 'business', 'enterprise'));--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_status_ck" CHECK (status in ('active', 'trialing', 'past_due', 'paused', 'canceled'));--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_interval_ck" CHECK (interval in ('month', 'year'));