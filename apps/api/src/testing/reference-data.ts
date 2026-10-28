import { NOTICE_DESTINATION, SYNC_SOURCES } from '@rejectradar/contracts';
import {
  type Database,
  fdaChargeCode,
  firmAlias,
  euMrl,
  euMrlProduct,
  euPesticideResidue,
  firmFei,
  importAlert,
  importAlertListingProduct,
  importAlertSummary,
  notice,
  rasffNotification,
  sourceSyncRun,
  ukBorderNotification,
} from '@rejectradar/db';
import { insertAuRow, insertFirm, insertListing, insertRefusal, refreshFirmAggregates } from '@rejectradar/entities';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC date `n` days before today, as `YYYY-MM-DD`. The notice windows count from today, so fixture dates are relative to it. */
export function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}

/** The ids `seedReferenceData` created. */
export interface ReferenceFixture {
  firms: { zarfeen: number; alRahmanLahore: number; alRahmanKarachi: number; mergedAway: number };
  /** The `notice.id` of each record. */
  notices: {
    recentRefusal: number;
    refusal13Months: number;
    refusal4Years: number;
    listing: number;
    rasff: number;
    uk: number;
    au: number;
  };
}

const ZARFEEN = 'ZARFEEN RICE MILLS (PVT) LTD';
const ZARFEEN_FEI = 3001234567;
const RICE = 101;
const CHILLI = 201;
const PESTICIDE_RESIDUES = 100;
const AFLATOXINS = 300;

const ALERT_SHA = 'a'.repeat(64);
const STALE_SHA = 'b'.repeat(64);

/** A summary's content as the model returns it; `tag` tells the locales apart in a spec. */
export function summaryContent(tag: string): Record<string, unknown> {
  return {
    summary: `FDA may detain foods without examination (${tag}).`,
    whatTriggersListing: `Pesticide residues above the limit (${tag}).`,
    howFirmsGetRemoved: `Submit laboratory results from several shipments (${tag}).`,
    testsMentioned: ['Pesticide residue analysis'],
  };
}

/**
 * Summaries of Import Alert 99-08, whose text hash is 'a'.repeat(64): English `approved`, Urdu `machine`, Hindi `draft`, and
 * Bengali `approved` but for an older text ('b'.repeat(64)). Import Alert 16-131 has an English `draft` and an Urdu `machine`.
 */
async function seedImportAlertSummaries(db: Database): Promise<void> {
  await db.insert(importAlert).values({
    number: '16-131',
    title: 'Detention Without Physical Examination of Fish and Fishery Products',
    alertType: 'DWPE',
    isFood: true,
    reasonText: 'FDA has found unapproved drug residues in fish.',
    textSha256: ALERT_SHA,
    url: 'https://www.accessdata.fda.gov/cms_ia/importalert_16-131.html',
  });
  const row = (alertNumber: string, locale: string, status: string, sourceSha256: string) => ({
    alertNumber,
    locale,
    status,
    sourceSha256,
    content: summaryContent(locale),
    model: 'fixture',
  });
  await db.insert(importAlertSummary).values([
    row('99-08', 'en', 'approved', ALERT_SHA),
    row('99-08', 'ur', 'machine', ALERT_SHA),
    row('99-08', 'hi', 'draft', ALERT_SHA),
    row('99-08', 'bn', 'approved', STALE_SHA),
    row('16-131', 'en', 'draft', ALERT_SHA),
    row('16-131', 'ur', 'machine', ALERT_SHA),
  ]);
}

/**
 * Reference data for the database-backed specs, as the syncs would leave it: every record is in its source table and
 * has its notice, the firms are linked and their facts refreshed, and each source has a sync run (all fresh, except
 * `eu_mrl` at 50 days). Dates are relative to today, because the windows are. Call it once per test database.
 *
 * - ZARFEEN RICE MILLS (PVT) LTD: PK, Lahore, FEI 3001234567, rice (101), with
 *   - FDA refusals 10 days ago ("Basmati Rice, milled"), 400 days (13 months) ago and 1,500 days (4 years) ago, all
 *     with hazard 300 (aflatoxins), charge code 2561 (in `fda_charge_code`) and a published address;
 *   - a red listing on Import Alert 99-08 with one product, listed and noticed 60 days ago;
 *   - an Australian failed test 40 days ago with a holding order.
 * - Import Alert 99-08 has its text and the summaries of `seedImportAlertSummaries`, as does 16-131.
 * - "Al Rahman Rice Mills" in Lahore and in Karachi (both PK), without records.
 * - `mergedAway`: a firm with a `firm_alias` row pointing to `zarfeen`.
 * - A RASFF alert from PK to the EU 20 days ago: rice, hazard 100 (pesticide residues), naming tricyclazole.
 * - EU MRLs: product 0500060 (Rice) with residues 1001 `tricyclazole` (0.09 mg/kg) and 1002 `under_score test` (0.01 mg/kg, at the limit of determination).
 * - A UK border notification 30 days ago: chilli from IN (201, under spices and herbs 200), hazard 300.
 */
export async function seedReferenceData(db: Database): Promise<ReferenceFixture> {
  const zarfeen = await insertFirm(db, {
    displayName: ZARFEEN,
    countryCode: 'PK',
    region: 'Punjab',
    city: 'lahore',
    postalCode: '54000',
    addressNorm: '12 industrial estate kot lakhpat lahore punjab 54000 pk',
  });
  const alRahmanLahore = await insertFirm(db, { displayName: 'Al Rahman Rice Mills', countryCode: 'PK', city: 'lahore' });
  const alRahmanKarachi = await insertFirm(db, { displayName: 'Al Rahman Rice Mills', countryCode: 'PK', city: 'karachi' });
  const mergedAway = await insertFirm(db, { displayName: 'Zarfeen Rice Mills Pvt Ltd', countryCode: 'PK', city: 'lahore' });
  await db.insert(firmAlias).values({ oldId: mergedAway, newId: zarfeen });
  await db.insert(firmFei).values({ fei: ZARFEEN_FEI, firmId: zarfeen, firstSeen: daysAgo(1500) });

  // The charge on the refusals, as FDA's charge-code list names it.
  await db.insert(fdaChargeCode).values({
    code: '2561',
    name: 'PESTICIDE',
    section: '402(a)(2)(B)',
    description: 'The article appears to contain a pesticide chemical residue that is unsafe within the meaning of section 408(a).',
  });

  // The ZARFEEN refusals: one per age, each with the address FDA publishes.
  const refusal = (age: number, productDesc: string) =>
    insertRefusal(
      db,
      {
        fei: ZARFEEN_FEI,
        firmName: ZARFEEN,
        addressLine1: '12 Industrial Estate, Kot Lakhpat',
        city: 'Lahore',
        region: 'Punjab',
        postalCode: '54000',
        countryCode: 'PK',
        divisionCode: 'DFPS',
        industryCode: '25',
        productCode: '25AEC99',
        productDesc,
        productCategory: 'Cereal Prods/Bakery Prods/Dough/Mixes/Ready-to-Eat Cereals',
        refusalDate: daysAgo(age),
        chargeCodes: ['2561'],
        fdaSampleAnalysis: true,
        commodityId: RICE,
        hazardIds: [AFLATOXINS],
        firmId: zarfeen,
      },
      { notice: { productText: productDesc, title: `${ZARFEEN} refused: ${productDesc}` } },
    );
  const recentRefusal = await refusal(10, 'Basmati Rice, milled');
  const refusal13Months = await refusal(400, 'Rice, milled');
  const refusal4Years = await refusal(1500, 'Rice, milled');

  // The red listing on Import Alert 99-08, with the one product its notice is written from.
  const listedOn = daysAgo(60);
  const listing = await insertListing(
    db,
    {
      alertNumber: '99-08',
      list: 'red',
      firmName: ZARFEEN,
      addressRaw: '12 Industrial Estate, Kot Lakhpat, Lahore, Punjab, 54000',
      city: 'Lahore',
      region: 'Punjab',
      countryCode: 'PK',
      countryName: 'Pakistan',
      listedOn,
      firstSeenOn: listedOn,
      lastSeenOn: daysAgo(0),
      firmId: zarfeen,
    },
    {
      alert: {
        title: 'Detention Without Physical Examination of Processed Human and Animal Foods for Pesticides',
        alertType: 'DWPE',
        publishedOn: '2023-05-02',
        reasonText: 'FDA has found pesticide residues above the legal limit in processed foods from several countries.',
        guidanceText: 'FDA may allow release of a shipment that is supported by laboratory results from an accredited lab.',
        productText: 'Processed human and animal foods, including rice.',
        chargeText: 'The articles appear to contain pesticide chemical residues.',
        textSha256: ALERT_SHA,
      },
      notice: {
        commodityId: RICE,
        productText: 'Rice, milled',
        title: `${ZARFEEN} on Import Alert 99-08`,
        url: 'https://www.accessdata.fda.gov/cms_ia/importalert_99-08.html',
      },
    },
  );
  await seedImportAlertSummaries(db);
  await db.insert(importAlertListingProduct).values({
    listingId: listing.id,
    productCode: '25AEC99',
    productName: 'Rice, milled',
    description: 'Rice, milled',
    listedOn,
    problems: ['Contains pesticide residues'],
    position: 0,
  });

  // The Australian failure, with a holding order. Its report month is the month it failed in.
  const failedOn = daysAgo(40);
  const au = await insertAuRow(
    db,
    {
      reportMonth: `${failedOn.slice(0, 7)}-01`,
      failedOn,
      productDesc: 'White rice, long grain',
      countryCode: 'PK',
      countryName: 'Pakistan',
      producerName: ZARFEEN,
      testApplied: 'Pesticide residues',
      reason: 'Pesticide residue above the maximum level',
      resultText: 'Fail',
      holdingOrderMatch: true,
      scheme: 'Surveillance',
      commodityId: RICE,
      firmId: zarfeen,
    },
    { notice: { productText: 'White rice, long grain', title: `${ZARFEEN}: White rice, long grain failed` } },
  );

  // RASFF and the UK notifications carry no firm, so their rows are written whole.
  const rasffSubject = 'Pesticide residues in rice from Pakistan';
  const rasffReference = '2026.9001';
  const rasffOn = daysAgo(20);
  const rasffUrl = 'https://webgate.ec.europa.eu/rasff-window/screen/notification/9001';
  await db.insert(rasffNotification).values({
    reference: rasffReference,
    notifiedOn: rasffOn,
    classification: 'alert',
    riskDecision: 'serious',
    notifyingCountry: 'DE',
    originCountries: ['PK'],
    distributionCountries: ['DE', 'NL'],
    productCategory: 'cereals and bakery products',
    subject: rasffSubject,
    hazards: [
      { name: 'tricyclazole', category: 'pesticide residues', analyticalResult: '0.12', unit: 'mg/kg', maxPermittedLvl: '0.01' },
    ],
    commodityId: RICE,
    hazardIds: [PESTICIDE_RESIDUES],
    url: rasffUrl,
    detailsFetchedAt: new Date(),
  });
  const [rasff] = await db
    .insert(notice)
    .values({
      source: 'rasff',
      sourceKey: rasffReference,
      destination: NOTICE_DESTINATION.rasff,
      noticeType: 'rasff_alert',
      noticeOn: rasffOn,
      originCountry: 'PK',
      commodityId: RICE,
      hazardIds: [PESTICIDE_RESIDUES],
      productText: rasffSubject,
      firmName: null,
      firmId: null,
      title: rasffSubject,
      url: rasffUrl,
    })
    .returning({ id: notice.id });

  const ukOn = daysAgo(30);
  const ukKey = `uk-${ukOn}-IN-chilli-powder`;
  await db.insert(ukBorderNotification).values({
    sourceKey: ukKey,
    notifiedOn: ukOn,
    originCountry: 'IN',
    countryName: 'India',
    commodity: 'Chilli',
    productCategory: 'Herbs and spices',
    productName: 'Dried chilli powder',
    hazardCategory: 'Mycotoxins',
    failureType: 'Official control',
    reason: 'Aflatoxins above the legal limit',
    consignmentType: 'Commercial',
    commodityId: CHILLI,
    hazardIds: [AFLATOXINS],
  });
  const [uk] = await db
    .insert(notice)
    .values({
      source: 'uk_bn',
      sourceKey: ukKey,
      destination: NOTICE_DESTINATION.uk_bn,
      noticeType: 'uk_border_notification',
      noticeOn: ukOn,
      originCountry: 'IN',
      commodityId: CHILLI,
      hazardIds: [AFLATOXINS],
      productText: 'Dried chilli powder',
      firmName: null,
      firmId: null,
      title: 'Dried chilli powder from India: aflatoxins above the legal limit',
      url: null,
    })
    .returning({ id: notice.id });

  // The EU MRLs: rice, two residues, and one limit for each (the second at the limit of determination).
  await db.insert(euMrlProduct).values({ code: '0500060', name: 'Rice', parentCode: '0500000' });
  await db.insert(euPesticideResidue).values([
    { id: '1001', name: 'tricyclazole', nameNorm: 'tricyclazole' },
    { id: '1002', name: 'under_score test', nameNorm: 'under_score test' },
  ]);
  await db.insert(euMrl).values([
    { productCode: '0500060', residueId: '1001', mrlMgKg: '0.09', isLod: false, legalRef: 'Reg. (EU) 2023/1234', applicableFrom: '2023-09-01' },
    { productCode: '0500060', residueId: '1002', mrlMgKg: '0.01', isLod: true },
  ]);

  // One succeeded, complete run per source: fresh, except the EU MRL import, which is 50 days old.
  await db.insert(sourceSyncRun).values(
    SYNC_SOURCES.map((source) => {
      const finishedAt = new Date(Date.now() - (source === 'eu_mrl' ? 50 : 1) * DAY_MS);
      return { source, status: 'succeeded', startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt, partial: false };
    }),
  );

  await refreshFirmAggregates(db, { today: daysAgo(0) });

  return {
    firms: { zarfeen, alRahmanLahore, alRahmanKarachi, mergedAway },
    notices: {
      recentRefusal: recentRefusal.noticeId as number,
      refusal13Months: refusal13Months.noticeId as number,
      refusal4Years: refusal4Years.noticeId as number,
      listing: listing.noticeId as number,
      rasff: rasff.id,
      uk: uk.id,
      au: au.noticeId as number,
    },
  };
}
