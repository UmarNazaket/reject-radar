import { EVENT_SEVERITY, type EventKind, NOTICE_DESTINATION, type NoticeSource } from '@rejectradar/contracts';
import { auFailingFood, changeEvent, fdaRefusal, firm, importAlert, importAlertListing, notice } from '@rejectradar/db';
import { normalizeName } from '@rejectradar/matching';
import type { DbOrTx } from './types';

// Fixture rows for the database-backed specs: each helper inserts a minimal valid row, takes any column as an override,
// and derives `name_norm` from the raw name the way the syncs do unless it is given.

/** A record a helper inserted: its row id, its key in its source and the id of its notice, when one was asked for. */
export interface FixtureRecord {
  id: number;
  key: string;
  noticeId: number | null;
}

/** The record's notice: `true` for one copied from the record as the sync writes it, or the columns to change in it. */
export type FixtureNotice = boolean | Partial<Omit<typeof notice.$inferInsert, 'source' | 'sourceKey'>>;

const DEFAULT_NAME = 'Fixture Foods';
const DEFAULT_DATE = '2026-01-15';

let fixtures = 0;
/** A key no other fixture of this test file has. */
const nextKey = (prefix: string): string => `${prefix}-${++fixtures}`;

async function insertNotice(
  db: DbOrTx,
  base: typeof notice.$inferInsert,
  option: FixtureNotice | undefined,
): Promise<number | null> {
  if (!option) return null;
  const [row] = await db
    .insert(notice)
    .values({ ...base, ...(option === true ? {} : option) })
    .returning({ id: notice.id });
  return row.id;
}

/** A firm named "Fixture Foods", with no address, FEI or facts. */
export async function insertFirm(db: DbOrTx, fields: Partial<typeof firm.$inferInsert> = {}): Promise<number> {
  const displayName = fields.displayName ?? DEFAULT_NAME;
  const [row] = await db
    .insert(firm)
    .values({ displayName, nameNorm: normalizeName(displayName).primary, ...fields })
    .returning({ id: firm.id });
  return row.id;
}

/** An unlinked FDA refusal without FEI, address or commodity. */
export async function insertRefusal(
  db: DbOrTx,
  fields: Partial<typeof fdaRefusal.$inferInsert> = {},
  options: { notice?: FixtureNotice } = {},
): Promise<FixtureRecord> {
  const firmName = fields.firmName ?? DEFAULT_NAME;
  const [row] = await db
    .insert(fdaRefusal)
    .values({
      sourceKey: nextKey('fda'),
      firmName,
      nameNorm: normalizeName(firmName).primary,
      refusalDate: DEFAULT_DATE,
      ...fields,
    })
    .returning();
  const noticeId = await insertNotice(
    db,
    {
      source: 'fda_refusal',
      sourceKey: row.sourceKey,
      destination: NOTICE_DESTINATION.fda_refusal,
      noticeType: 'refusal',
      noticeOn: row.refusalDate,
      originCountry: row.countryCode,
      commodityId: row.commodityId,
      hazardIds: row.hazardIds,
      firmName: row.firmName,
      firmId: row.firmId,
    },
    options.notice,
  );
  return { id: row.id, key: row.sourceKey, noticeId };
}

/**
 * An unlinked red-list listing on Import Alert 99-08. Its alert is inserted first when missing, as a current food alert
 * unless `options.alert` says otherwise. Ask for `options.notice` to give it the notice a red-list listing has.
 */
export async function insertListing(
  db: DbOrTx,
  fields: Partial<typeof importAlertListing.$inferInsert> = {},
  options: { alert?: Partial<Omit<typeof importAlert.$inferInsert, 'number'>>; notice?: FixtureNotice } = {},
): Promise<FixtureRecord> {
  const alertNumber = fields.alertNumber ?? '99-08';
  await db
    .insert(importAlert)
    .values({
      number: alertNumber,
      title: `Import Alert ${alertNumber}`,
      isFood: true,
      textSha256: 'fixture',
      url: `https://www.accessdata.fda.gov/cms_ia/importalert_${alertNumber}.html`,
      ...options.alert,
    })
    .onConflictDoNothing();
  const firmName = fields.firmName ?? DEFAULT_NAME;
  const [row] = await db
    .insert(importAlertListing)
    .values({
      listingKey: nextKey('ia'),
      alertNumber,
      list: 'red',
      firmName,
      nameNorm: normalizeName(firmName).primary,
      firstSeenOn: DEFAULT_DATE,
      lastSeenOn: DEFAULT_DATE,
      ...fields,
    })
    .returning();
  const noticeId = await insertNotice(
    db,
    {
      source: 'import_alert',
      sourceKey: row.listingKey,
      destination: NOTICE_DESTINATION.import_alert,
      noticeType: 'import_alert_listing',
      noticeOn: row.listedOn ?? row.firstSeenOn,
      originCountry: row.countryCode,
      firmName: row.firmName,
      firmId: row.firmId,
    },
    options.notice,
  );
  return { id: row.id, key: row.listingKey, noticeId };
}

/** An unlinked Australian failed test of a product by "Fixture Foods"; `producerName: null` gives a row without one. */
export async function insertAuRow(
  db: DbOrTx,
  fields: Partial<typeof auFailingFood.$inferInsert> = {},
  options: { notice?: FixtureNotice } = {},
): Promise<FixtureRecord> {
  const producerName = fields.producerName === undefined ? DEFAULT_NAME : fields.producerName;
  const [row] = await db
    .insert(auFailingFood)
    .values({
      sourceKey: nextKey('au'),
      reportMonth: '2026-01-01',
      productDesc: 'Fixture product',
      producerName,
      nameNorm: producerName === null ? '' : normalizeName(producerName).primary,
      ...fields,
    })
    .returning();
  const noticeId = await insertNotice(
    db,
    {
      source: 'au_ifis',
      sourceKey: row.sourceKey,
      destination: NOTICE_DESTINATION.au_ifis,
      noticeType: 'au_failed_test',
      noticeOn: row.failedOn ?? row.reportMonth,
      originCountry: row.countryCode,
      commodityId: row.commodityId,
      hazardIds: row.hazardIds,
      firmName: row.producerName,
      firmId: row.firmId,
    },
    options.notice,
  );
  return { id: row.id, key: row.sourceKey, noticeId };
}

/** The kind of event each source emits for a new record, for an event that names none. */
const NEW_RECORD_EVENT: Readonly<Record<NoticeSource, EventKind>> = {
  fda_refusal: 'fda_refusal',
  import_alert: 'import_alert_listed',
  rasff: 'rasff_notification',
  uk_bn: 'uk_border_notification',
  au_ifis: 'au_failed_test',
};

/** A change event about the record that `source` and `sourceKey` name; `firm_id` is null, as a sync writes it, unless given. */
export async function insertEvent(
  db: DbOrTx,
  fields: { source: NoticeSource; sourceKey: string; kind?: EventKind } & Partial<
    Omit<typeof changeEvent.$inferInsert, 'source' | 'sourceKey' | 'kind'>
  >,
): Promise<number> {
  const kind = fields.kind ?? NEW_RECORD_EVENT[fields.source];
  const [row] = await db
    .insert(changeEvent)
    .values({
      severity: EVENT_SEVERITY[kind],
      occurredOn: DEFAULT_DATE,
      destination: NOTICE_DESTINATION[fields.source],
      ...fields,
      kind,
    })
    .returning({ id: changeEvent.id });
  return row.id;
}
