-- Test data for the nightly end-to-end run, applied after the migrations to an empty database.
-- The user signs in as e2e@example.com with the password e2e-check-2026.

insert into org (id, name) values ('0192e2e0-0000-7000-8000-000000000001', 'E2E Spices');
insert into app_user (id, email, password_hash, name, email_verified_at) values (
  '0192e2e0-0000-7000-8000-000000000002', 'e2e@example.com',
  '$argon2id$v=19$m=19456,p=1,t=2$m6NiChiJ+BpMn6euQvcNCw$5GgJTfNeUeIJxOZSvkJN5ECskgekXeEkkIOhipreGXY',
  'E2E User', now());
insert into membership (org_id, user_id, role) values ('0192e2e0-0000-7000-8000-000000000001', '0192e2e0-0000-7000-8000-000000000002', 'owner');

-- A firm with two FDA refusals, one inside and one outside the last three years.
insert into firm (display_name, name_norm, country_code, region, city, commodity_ids, first_seen, last_notice_on, flags, metrics)
values ('E2E Spice Mills Pvt Ltd', 'e2e spice mills', 'IN', 'Kerala', 'Kochi', '{201}', '2021-02-01', current_date - 20,
  '{"import_alert_red":[{"alert":"99-08","listed_on":"2024-05-02"}],"import_alert_green":[],"fda_refusals_12m":1,"fda_refusals_3y":1,"au_failed_3y":0,"au_holding_order":false,"top_hazards_3y":["pesticide_residues"]}',
  '{"fda_refusals_total":2,"au_failed_total":0,"import_alert_red_current":1,"import_alert_green_current":0}');
insert into firm_fei (fei, firm_id) select 3000000001, id from firm where name_norm = 'e2e spice mills';
insert into fda_refusal (source_key, fei, firm_name, name_norm, city, country_code, product_code, product_desc, refusal_date, charge_codes, firm_id)
select k, 3000000001, 'E2E Spice Mills Pvt Ltd', 'e2e spice mills', 'Kochi', 'IN', '28B', d, dt, '{PESTICIDE}', f.id
from firm f, (values ('e2e-r1', 'Chilli powder', current_date - 20), ('e2e-r2', 'Turmeric whole', current_date - interval '4 years')) v(k, d, dt)
where f.name_norm = 'e2e spice mills';

-- Forty notices from India over the last year, across the four destinations.
insert into notice (source, source_key, destination, notice_type, notice_on, origin_country, commodity_id, hazard_ids, product_text, firm_name, url)
select s.src, 'e2e-' || g, s.dest, s.typ, current_date - (g * 9), 'IN', (array[101, 201, 202, 102])[1 + g % 4],
  array[(array[100, 200, 300, 301])[1 + g % 4]], 'E2E product ' || g, 'E2E Firm ' || (g % 5), 'https://example.com/notice/' || g
from generate_series(1, 40) g
cross join lateral (
  select (array['fda_refusal', 'rasff', 'uk_bn', 'au_ifis'])[1 + g % 4] as src,
    (array['US', 'EU', 'UK', 'AU'])[1 + g % 4] as dest,
    (array['refusal', 'rasff_border_rejection', 'uk_border_notification', 'au_failed_test'])[1 + g % 4] as typ
) s;

-- An Import Alert with an approved English summary, and the firm's listing on it as a notice.
insert into import_alert (number, title, alert_type, published_on, is_food, reason_text, product_text, text_sha256, url)
values ('99-08', 'Detention Without Physical Examination of Processed Foods for Pesticides', 'DWPE', '2024-03-12', true,
  'Samples of processed foods have been found to contain pesticide residues above tolerances.', 'Processed foods.', 'e2e-sha',
  'https://example.com/importalert_99-08.html');
insert into import_alert_summary (alert_number, locale, content, source_sha256, model, status, reviewed_at)
values ('99-08', 'en',
  '{"summary":"FDA holds processed foods from listed firms at the border.","whatTriggersListing":"A sample over a US pesticide tolerance.","howFirmsGetRemoved":"Clean shipments, then a petition to FDA.","testsMentioned":[]}',
  'e2e-sha', 'e2e', 'approved', now());
insert into notice (source, source_key, destination, notice_type, notice_on, origin_country, commodity_id, hazard_ids, product_text, firm_name, firm_id, title, url)
select 'import_alert', 'e2e-ia-1', 'US', 'import_alert_listing', current_date - 3, 'IN', 201, array[100], 'Chilli powder',
  'E2E Spice Mills Pvt Ltd', id, 'E2E Spice Mills Pvt Ltd on Import Alert 99-08', 'https://example.com/importalert_99-08.html'
from firm where name_norm = 'e2e spice mills';

-- RejectRadar staff (P10), with the same password: e2e-staff@example.com. A second firm like the first, and the
-- matcher's open review of the two.
insert into org (id, name) values ('0192e2e0-0000-7000-8000-000000000003', 'RejectRadar');
insert into app_user (id, email, password_hash, name, email_verified_at, is_platform_admin) values (
  '0192e2e0-0000-7000-8000-000000000004', 'e2e-staff@example.com',
  '$argon2id$v=19$m=19456,p=1,t=2$m6NiChiJ+BpMn6euQvcNCw$5GgJTfNeUeIJxOZSvkJN5ECskgekXeEkkIOhipreGXY',
  'E2E Staff', now(), true);
insert into membership (org_id, user_id, role) values ('0192e2e0-0000-7000-8000-000000000003', '0192e2e0-0000-7000-8000-000000000004', 'owner');
insert into firm (display_name, name_norm, country_code, region, city) values ('E2E Spice Mill', 'e2e spice mill', 'IN', 'Kerala', 'Ernakulam');
insert into match_review (source, source_key, firm_id, candidate_firm_id, score, evidence)
select 'fda_refusal', 'e2e-r1', a.id, b.id, 0.8200, '{"name":0.95,"address":0.4}'
from firm a, firm b where a.name_norm = 'e2e spice mills' and b.name_norm = 'e2e spice mill';
