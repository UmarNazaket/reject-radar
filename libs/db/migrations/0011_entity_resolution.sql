CREATE INDEX "firm_alias_new_idx" ON "firm_alias" USING btree ("new_id");--> statement-breakpoint
CREATE INDEX "match_review_source_key_idx" ON "match_review" USING btree ("source","source_key");--> statement-breakpoint
CREATE INDEX "match_review_candidate_idx" ON "match_review" USING btree ("candidate_firm_id");--> statement-breakpoint
ALTER TABLE "match_review" ADD CONSTRAINT "match_review_reason_ck" CHECK (reason in ('score_band', 'second_fei'));--> statement-breakpoint
ALTER TABLE "match_review" ADD CONSTRAINT "match_review_status_ck" CHECK (status in ('open', 'linked', 'kept_separate'));