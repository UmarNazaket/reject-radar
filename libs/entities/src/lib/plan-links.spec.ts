import type { FirmRecordSource, MatchReviewReason } from '@rejectradar/contracts';
import { type LinkEvidence, normalizeAddress, normalizeName, type RawAddress } from '@rejectradar/matching';
import { CandidateIndex } from './candidate-index';
import { countryTokenFrequencies, type FirmView, planLinks, rankCandidates } from './plan-links';
import type { FirmRecord, FirmRef, KnownFirm, LinkPlan, NewFirm, RecordLink, ReviewDraft } from './types';

type RecordOptions = Partial<Pick<FirmRecord, 'fei' | 'commodityIds'>>;

/** Unlinked records of one source as `loadLinkInput` gives them: the raw name, with name and address normalised. */
const recordsOf =
  (source: FirmRecordSource) =>
  (key: string, seenOn: string, firmName: string, where: RawAddress | null, more: RecordOptions = {}): FirmRecord => ({
    source,
    key,
    fei: null,
    firmName,
    nameNorm: normalizeName(firmName).primary,
    address: normalizeAddress(where),
    commodityIds: [],
    seenOn,
    ...more,
  });
const refusal = recordsOf('fda_refusal');
const listing = recordsOf('import_alert');
const auRow = recordsOf('au_ifis');

/** A firm already in the database, stored with its name and address normalised. */
function knownFirm(
  id: number,
  name: string,
  where: RawAddress | null,
  more: Partial<Pick<KnownFirm, 'commodityIds' | 'feis'>> = {},
): KnownFirm {
  return {
    id,
    nameNorm: normalizeName(name).primary,
    address: normalizeAddress(where),
    commodityIds: [],
    feis: [],
    ...more,
  };
}

const existing = (id: number): FirmRef => ({ kind: 'existing', id });
const created = (index: number): FirmRef => ({ kind: 'new', index });
const linked = ({ source, key }: FirmRecord, firm: FirmRef, score: number): RecordLink => ({
  source,
  key,
  firm,
  score,
});

/** The firm a plan makes from `representative`, whose name and address it takes (P3-D6). */
function newFirm(index: number, representative: FirmRecord, firstSeen = representative.seenOn): NewFirm {
  const { firmName: displayName, nameNorm, address, source, key } = representative;
  return { index, displayName, nameNorm, address, firstSeen, source, key };
}

/** Evidence of a pair that shares only its country; each pair below adds what else it shares. */
const countryOnly: LinkEvidence = {
  nameSim: 0,
  sameCountry: true,
  addressMatch: false,
  exactDistinctiveName: false,
  postalMatch: false,
  cityMatch: false,
  regionMatch: false,
  productOverlap: false,
};

/** "Zhanjiang Evergreen Aquatic Products" against a firm "… Aquatic Product" in its city, sharing a commodity. */
const pluralInSameCity: ReviewDraft['evidence'] = {
  ...countryOnly,
  nameSim: 0.99375,
  cityMatch: true,
  productOverlap: true,
  parts: { name: 0.7453, location: 0.12, locationReason: 'city', product: 0.03, total: 0.8953 },
};

/** A new FEI's only refusal `r` with a firm of its own: the firm, its link, the FEI, and `reviews`. */
function ownFirm(r: FirmRecord, reviews: ReviewDraft[] = []): LinkPlan {
  return {
    newFirms: [newFirm(0, r)],
    links: [linked(r, created(0), 1)],
    feis: [{ fei: r.fei as number, firm: created(0), firstSeen: r.seenOn }],
    reviews,
  };
}

/** The review of `r`'s new firm against `candidate`, at the score `evidence` adds up to. */
function reviewOf(
  r: FirmRecord,
  candidate: FirmRef,
  reason: MatchReviewReason,
  evidence: ReviewDraft['evidence'],
): ReviewDraft {
  return { source: r.source, key: r.key, firm: created(0), candidate, score: evidence.parts.total, reason, evidence };
}

/** "Zhanjiang Evergreen Aquatic Products" against a firm "… Aquatic Product" at its postal code, in its city. */
const pluralAtPostalCode: ReviewDraft['evidence'] = {
  ...countryOnly,
  nameSim: 0.99375,
  postalMatch: true,
  cityMatch: true,
  parts: { name: 0.7453, location: 0.15, locationReason: 'postal_code', product: 0, total: 0.8953 },
};

/** The same pair in the same city only. */
const pluralInCityOnly: ReviewDraft['evidence'] = {
  ...countryOnly,
  nameSim: 0.99375,
  cityMatch: true,
  parts: { name: 0.7453, location: 0.12, locationReason: 'city', product: 0, total: 0.8653 },
};

/** Guatemala: the street "5ta Calle" with a house number, in zone 1 of Chimaltenango. */
const sanJuanPlant: RawAddress = { line1: '5ta Calle 3-45 Zona 1', city: 'Chimaltenango', country: 'GT' };

/** "Agroindustrias San Juan" against a firm "Agro Industrias San Juan" at its address and in its city. */
const sanJuanAtAddress: ReviewDraft['evidence'] = {
  ...countryOnly,
  nameSim: expect.closeTo(0.8077, 4),
  addressMatch: true,
  cityMatch: true,
  parts: { name: 0.6058, location: 0.25, locationReason: 'address', product: 0, total: 0.8558 },
};

/** `items` in an order fixed by `seed`: Fisher-Yates driven by a 32-bit linear congruential generator. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

describe('planLinks', () => {
  it('links refusals of a known FEI with score 1.0', () => {
    const firm = knownFirm(3, 'SHANDONG LONGDA FOOD', { city: 'Laiyang', country: 'CN' }, { feis: [3002345678] });
    // The FEI is enough: neither the name nor the country has to agree with the firm's.
    const first = refusal(
      'r-1',
      '2024-01-15',
      'SHANDONG LONGDA FOOD CO LTD',
      { city: 'Laiyang', country: 'CN' },
      { fei: 3002345678 },
    );
    const second = refusal('r-2', '2024-03-02', 'LONGDA FOODSTUFF GROUP', null, { fei: 3002345678 });

    expect(planLinks({ firms: [firm], records: [second, first] })).toEqual({
      newFirms: [],
      links: [linked(first, existing(3), 1), linked(second, existing(3), 1)],
      feis: [],
      reviews: [],
    });
  });

  it('creates one firm per new FEI from its latest refusal', () => {
    // The keys sort the other way round from the dates, so only the dates can make the 2024 refusal the latest.
    const older = refusal('r-9', '2020-03-02', 'ABC FOODS', { city: 'Bangkok', country: 'TH' }, { fei: 3001234567 });
    const newer = refusal(
      'r-1',
      '2024-06-11',
      'ABC FOODS INTERNATIONAL',
      { line1: '99 Moo 4 Sukhumvit Road', city: 'Samut Prakan', country: 'TH' },
      { fei: 3001234567 },
    );

    expect(planLinks({ firms: [], records: [newer, older] })).toEqual({
      newFirms: [
        {
          index: 0,
          displayName: 'ABC FOODS INTERNATIONAL',
          nameNorm: 'abc foods international',
          address: newer.address,
          firstSeen: '2020-03-02',
          source: 'fda_refusal',
          key: 'r-1',
        },
      ],
      links: [linked(older, created(0), 1), linked(newer, created(0), 1)],
      feis: [{ fei: 3001234567, firm: created(0), firstSeen: '2020-03-02' }],
      reviews: [],
    });
  });

  it('attaches a new FEI to a strongly matching firm without an FEI', () => {
    // Firm 7 came from an Import Alert listing, which carries no FEI.
    const firm = knownFirm(
      7,
      'DALIAN TIANTIAN SEAFOOD CO., LTD.',
      { city: 'Dalian', country: 'CN' },
      { commodityIds: [5] },
    );
    const first = refusal(
      'r-1',
      '2023-02-01',
      'Dalian Tiantian Seafood Co Ltd',
      { city: 'Dalian', country: 'China' },
      { fei: 3007654321, commodityIds: [5] },
    );
    const latest = refusal(
      'r-2',
      '2023-09-14',
      'DALIAN TIANTIAN SEAFOOD',
      { city: 'Dalian', country: 'China' },
      { fei: 3007654321 },
    );

    // Same distinctive name, same city: 0.75 + 0.25 = 1.
    expect(planLinks({ firms: [firm], records: [latest, first] })).toEqual({
      newFirms: [],
      links: [linked(first, existing(7), 1), linked(latest, existing(7), 1)],
      feis: [{ fei: 3007654321, firm: existing(7), firstSeen: '2023-02-01' }],
      reviews: [],
    });
  });

  it("links an attached FEI's refusals with the match score, and the firm then counts as having that FEI", () => {
    const where: RawAddress = { city: 'Zhanjiang', postalCode: '524000', country: 'China' };
    const firm = knownFirm(12, 'ZHANJIANG EVERGREEN AQUATIC PRODUCT', where, { commodityIds: [5] });
    const name = 'ZHANJIANG EVERGREEN AQUATIC PRODUCTS CO LTD';
    const a1 = refusal('r-1', '2023-01-05', name, where, { fei: 3001000001, commodityIds: [5] });
    const a2 = refusal('r-2', '2023-06-01', name, where, { fei: 3001000001, commodityIds: [5] });
    const b = refusal('r-3', '2024-02-01', name, where, { fei: 3002000002, commodityIds: [5] });

    // "products" against "product", same postal code, shared commodity: 0.7453 + 0.15 + 0.03 = 0.9253, a link.
    const match: ReviewDraft['evidence'] = {
      ...countryOnly,
      nameSim: 0.99375,
      postalMatch: true,
      cityMatch: true,
      productOverlap: true,
      parts: { name: 0.7453, location: 0.15, locationReason: 'postal_code', product: 0.03, total: 0.9253 },
    };
    expect(planLinks({ firms: [firm], records: [b, a2, a1] })).toEqual({
      newFirms: [newFirm(0, b)],
      links: [linked(a1, existing(12), 0.9253), linked(a2, existing(12), 0.9253), linked(b, created(0), 1)],
      feis: [
        { fei: 3001000001, firm: existing(12), firstSeen: '2023-01-05' },
        { fei: 3002000002, firm: created(0), firstSeen: '2024-02-01' },
      ],
      reviews: [
        {
          source: 'fda_refusal',
          key: 'r-3',
          firm: created(0),
          candidate: existing(12),
          score: 0.9253,
          reason: 'second_fei',
          evidence: match,
        },
      ],
    });
  });

  it('opens a second_fei review when another FEI holder matches by name and address', () => {
    // One company's plants in two cities, each with its own FEI. Both firms score 1 and firm 8 ranks first on its id,
    // but only firm 9 is at the new FEI's address.
    const unjha = knownFirm(8, 'GURUDEV SPICES', { city: 'Unjha', country: 'IN' }, { feis: [3005550001] });
    const plot14: RawAddress = { line1: 'Plot 14, GIDC Estate', city: 'Mehsana', country: 'IN' };
    const mehsana = knownFirm(9, 'GURUDEV SPICES', plot14, { feis: [3005550003] });
    const r = refusal('r-1', '2024-04-20', 'GURUDEV SPICES PVT LTD', plot14, { fei: 3005550002 });

    expect(planLinks({ firms: [unjha, mehsana], records: [r] })).toEqual({
      newFirms: [newFirm(0, r)],
      links: [linked(r, created(0), 1)],
      feis: [{ fei: 3005550002, firm: created(0), firstSeen: '2024-04-20' }],
      reviews: [
        {
          source: 'fda_refusal',
          key: 'r-1',
          firm: created(0),
          candidate: existing(9),
          score: 1,
          reason: 'second_fei',
          evidence: {
            ...countryOnly,
            nameSim: 1,
            addressMatch: true,
            exactDistinctiveName: true,
            cityMatch: true,
            parts: { name: 0.75, location: 0.25, locationReason: 'address', product: 0, total: 1 },
          },
        },
      ],
    });
  });

  it('opens a second_fei review when another FEI holder matches by name and postal code', () => {
    const firm = knownFirm(
      8,
      'GURUDEV SPICES',
      { city: 'Unjha', postalCode: '384170', country: 'IN' },
      { commodityIds: [9], feis: [3005550001] },
    );
    const r = refusal(
      'r-1',
      '2024-04-20',
      'GURUDEV SPICES PVT LTD',
      { city: 'Unjha', postalCode: '384170', country: 'India' },
      { fei: 3005550002, commodityIds: [9] },
    );

    // The postal code is what opens the review, although the distinctive name earns the location bonus.
    expect(planLinks({ firms: [firm], records: [r] })).toEqual({
      newFirms: [newFirm(0, r)],
      links: [linked(r, created(0), 1)],
      feis: [{ fei: 3005550002, firm: created(0), firstSeen: '2024-04-20' }],
      reviews: [
        {
          source: 'fda_refusal',
          key: 'r-1',
          firm: created(0),
          candidate: existing(8),
          score: 1,
          reason: 'second_fei',
          evidence: {
            ...countryOnly,
            nameSim: 1,
            exactDistinctiveName: true,
            postalMatch: true,
            cityMatch: true,
            productOverlap: true,
            parts: { name: 0.75, location: 0.25, locationReason: 'distinctive_exact_name', product: 0.03, total: 1 },
          },
        },
      ],
    });
  });

  it('opens no review for a new FEI whose name matches another FEI holder in the same city', () => {
    const firm = knownFirm(
      8,
      'GURUDEV SPICES',
      { city: 'Unjha', country: 'IN' },
      { commodityIds: [9], feis: [3005550001] },
    );
    const r = refusal(
      'r-1',
      '2024-04-20',
      'GURUDEV SPICES PVT LTD',
      { city: 'Unjha', country: 'India' },
      { fei: 3005550002, commodityIds: [9] },
    );

    // Exact distinctive name in the same city: 1, but a city is not an address. FDA gives each establishment its own
    // FEI, so without the same address or postal code this is another plant (ruling R13).
    expect(planLinks({ firms: [firm], records: [r] })).toEqual({
      newFirms: [newFirm(0, r)],
      links: [linked(r, created(0), 1)],
      feis: [{ fei: 3005550002, firm: created(0), firstSeen: '2024-04-20' }],
      reviews: [],
    });
  });

  it('opens no review for a new FEI whose name matches another FEI holder in another city', () => {
    const firm = knownFirm(5, 'ABHAYA EXPORTS', { city: 'Navi Mumbai', country: 'IN' }, { feis: [3006660001] });
    const r = refusal(
      'r-1',
      '2024-04-20',
      'ABHAYA EXPORTS',
      { city: 'Kolkata', country: 'India' },
      { fei: 3006660002 },
    );

    // The distinctive name alone scores 0.75 + 0.25 = 1.
    expect(planLinks({ firms: [firm], records: [r] })).toEqual({
      newFirms: [newFirm(0, r)],
      links: [linked(r, created(0), 1)],
      feis: [{ fei: 3006660002, firm: created(0), firstSeen: '2024-04-20' }],
      reviews: [],
    });
  });

  it('prefers attaching to a link-band firm without an FEI over a second_fei review', () => {
    const where: RawAddress = { city: 'Zhanjiang', postalCode: '524000', country: 'CN' };
    // Firm 3 holds another FEI and ranks first, by exact name and postal code: on its own, a second_fei review.
    const holder = knownFirm(3, 'ZHANJIANG EVERGREEN AQUATIC PRODUCTS', where, {
      commodityIds: [5],
      feis: [3001000001],
    });
    // Firm 12 has no FEI and matches strongly too: 0.7453 + 0.15 + 0.03 = 0.9253.
    const listed = knownFirm(12, 'ZHANJIANG EVERGREEN AQUATIC PRODUCT', where, { commodityIds: [5] });
    const r = refusal('r-1', '2024-02-01', 'ZHANJIANG EVERGREEN AQUATIC PRODUCTS CO LTD', where, {
      fei: 3002000002,
      commodityIds: [5],
    });

    expect(planLinks({ firms: [holder, listed], records: [r] })).toEqual({
      newFirms: [],
      links: [linked(r, existing(12), 0.9253)],
      feis: [{ fei: 3002000002, firm: existing(12), firstSeen: '2024-02-01' }],
      reviews: [],
    });
  });

  it('prefers a second_fei review over a score_band review', () => {
    const where: RawAddress = { city: 'Unjha', postalCode: '384170', country: 'IN' };
    // Firm 8 holds another FEI and matches by name and postal code: 1.
    const holder = knownFirm(8, 'GURUDEV SPICES', where, { feis: [3005550001] });
    // Firm 2 has no FEI and a near name in the same city: 0.7406 + 0.12 = 0.8606, the review band.
    const listed = knownFirm(2, 'GURUDEVA SPICES', { city: 'Unjha', country: 'IN' });
    const r = refusal('r-1', '2024-04-20', 'GURUDEV SPICES PVT LTD', where, { fei: 3005550002 });

    // The higher score opens its review.
    expect(planLinks({ firms: [holder, listed], records: [r] })).toEqual(
      ownFirm(r, [
        reviewOf(r, existing(8), 'second_fei', {
          ...countryOnly,
          nameSim: 1,
          exactDistinctiveName: true,
          postalMatch: true,
          cityMatch: true,
          parts: { name: 0.75, location: 0.25, locationReason: 'distinctive_exact_name', product: 0, total: 1 },
        }),
      ]),
    );
  });

  it('creates a firm and a score_band review between 0.75 and 0.90', () => {
    const firm = knownFirm(
      12,
      'ZHANJIANG EVERGREEN AQUATIC PRODUCT',
      { city: 'Zhanjiang', country: 'CN' },
      { commodityIds: [5] },
    );
    const r = listing(
      'ia-1',
      '2024-05-06',
      'ZHANJIANG EVERGREEN AQUATIC PRODUCTS CO., LTD',
      { city: 'Zhanjiang', country: 'CN' },
      { commodityIds: [5] },
    );

    // 0.7453 + 0.12 + 0.03 = 0.8953.
    expect(planLinks({ firms: [firm], records: [r] })).toEqual({
      newFirms: [newFirm(0, r)],
      links: [linked(r, created(0), 1)],
      feis: [],
      reviews: [
        {
          source: 'import_alert',
          key: 'ia-1',
          firm: created(0),
          candidate: existing(12),
          score: 0.8953,
          reason: 'score_band',
          evidence: pluralInSameCity,
        },
      ],
    });
  });

  it('gives a new FEI between 0.75 and 0.90 its own firm and a score_band review', () => {
    const where: RawAddress = { city: 'Zhanjiang', country: 'CN' };
    const firm = knownFirm(12, 'ZHANJIANG EVERGREEN AQUATIC PRODUCT', where, { commodityIds: [5] });
    const r = refusal('r-1', '2024-05-06', 'ZHANJIANG EVERGREEN AQUATIC PRODUCTS CO., LTD', where, {
      fei: 3003000003,
      commodityIds: [5],
    });

    expect(planLinks({ firms: [firm], records: [r] })).toEqual({
      newFirms: [newFirm(0, r)],
      links: [linked(r, created(0), 1)],
      feis: [{ fei: 3003000003, firm: created(0), firstSeen: '2024-05-06' }],
      reviews: [
        {
          source: 'fda_refusal',
          key: 'r-1',
          firm: created(0),
          candidate: existing(12),
          score: 0.8953,
          reason: 'score_band',
          evidence: pluralInSameCity,
        },
      ],
    });
  });

  it('never opens a score_band review against an FEI holder for a new FEI', () => {
    // Firm 12 holds another FEI and shares the city, though no address, postal code or commodity: 0.7453 + 0.12 =
    // 0.8653, the review band. A firm with another FEI is another establishment unless, in the review band, the postal
    // code, or the address and the city, agree (ruling R17).
    const holder = knownFirm(
      12,
      'ZHANJIANG EVERGREEN AQUATIC PRODUCT',
      { city: 'Zhanjiang', country: 'CN' },
      { feis: [3001000001] },
    );
    const r = refusal(
      'r-1',
      '2024-05-06',
      'ZHANJIANG EVERGREEN AQUATIC PRODUCTS CO., LTD',
      { city: 'Zhanjiang', postalCode: '524000', country: 'CN' },
      { fei: 3003000003 },
    );

    expect(planLinks({ firms: [holder], records: [r] })).toEqual(ownFirm(r));

    // A firm without an FEI still gets its review, though it ranks below firm 12 on its id: the same score.
    const listed = knownFirm(13, 'ZHANJIANG EVERGREEN AQUATIC PRODUCT', { city: 'Zhanjiang', country: 'CN' });
    expect(planLinks({ firms: [holder, listed], records: [r] })).toEqual(
      ownFirm(r, [reviewOf(r, existing(13), 'score_band', pluralInCityOnly)]),
    );
  });

  it('opens second_fei for an FEI holder that matches by address and city in the review band', () => {
    // One plant under two FEIs, its name spelt two ways: 0.6058 + 0.25 = 0.8558 (ruling R17).
    const holder = knownFirm(5, 'AGRO INDUSTRIAS SAN JUAN', sanJuanPlant, { feis: [3008880001] });
    const r = refusal('r-1', '2024-03-11', 'AGROINDUSTRIAS SAN JUAN S.A.', sanJuanPlant, { fei: 3008880002 });

    expect(planLinks({ firms: [holder], records: [r] })).toEqual(
      ownFirm(r, [reviewOf(r, existing(5), 'second_fei', sanJuanAtAddress)]),
    );
  });

  it('opens no second_fei in the review band when the address matches but the city does not', () => {
    // "5ta Calle" is a street in many Guatemalan towns, and an address match ignores the city. The names, spelt two
    // ways, and the address line score 0.6058 + 0.25 = 0.8558, the review band, where the city has to agree too
    // (ruling R17, kept by R22): the plants are in two towns.
    const holder = knownFirm(5, 'AGRO INDUSTRIAS SAN JUAN', sanJuanPlant, { feis: [3008880001] });
    const r = refusal(
      'r-1',
      '2024-03-11',
      'AGROINDUSTRIAS SAN JUAN S.A.',
      { ...sanJuanPlant, city: 'Huehuetenango' },
      { fei: 3008880002 },
    );

    expect(planLinks({ firms: [holder], records: [r] })).toEqual(ownFirm(r));
  });

  it('opens second_fei in the link band when the address matches though the city differs', () => {
    // FDA's city field often holds a region ("Kerala"), a district or a misspelling, so the city is no test at 0.90 or
    // more, where the name is close already (ruling R22, back to R13). The exact distinctive name and the address line
    // score 1: a review, though the two cities differ.
    const holder = knownFirm(
      5,
      'FARMAMEDICA',
      { line1: '5ta Calle Zona 1', city: 'Guatemala City', country: 'GT' },
      { feis: [3008880001] },
    );
    const r = refusal(
      'r-1',
      '2024-03-11',
      'FARMAMEDICA S.A.',
      { line1: '5ta Calle Zona 1', city: 'Huehuetenango', country: 'GT' },
      { fei: 3008880002 },
    );

    expect(planLinks({ firms: [holder], records: [r] })).toEqual(
      ownFirm(r, [
        reviewOf(r, existing(5), 'second_fei', {
          ...countryOnly,
          nameSim: 1,
          addressMatch: true,
          exactDistinctiveName: true,
          parts: { name: 0.75, location: 0.25, locationReason: 'address', product: 0, total: 1 },
        }),
      ]),
    );
  });

  it('opens second_fei for a postal-code match in the review band', () => {
    // Firm 12 holds another FEI at the postal code, though no commodity: 0.7453 + 0.15 = 0.8953 (ruling R17).
    const where: RawAddress = { city: 'Zhanjiang', postalCode: '524000', country: 'CN' };
    const holder = knownFirm(12, 'ZHANJIANG EVERGREEN AQUATIC PRODUCT', where, { feis: [3001000001] });
    const r = refusal('r-1', '2024-05-06', 'ZHANJIANG EVERGREEN AQUATIC PRODUCTS CO., LTD', where, { fei: 3003000003 });

    expect(planLinks({ firms: [holder], records: [r] })).toEqual(
      ownFirm(r, [reviewOf(r, existing(12), 'second_fei', pluralAtPostalCode)]),
    );
  });

  it('opens the higher-scoring review when a duplicate FEI and a firm without an FEI both qualify', () => {
    const where: RawAddress = { city: 'Zhanjiang', postalCode: '524000', country: 'CN' };
    const r = refusal('r-1', '2024-05-06', 'ZHANJIANG EVERGREEN AQUATIC PRODUCTS CO., LTD', where, { fei: 3003000003 });
    const holder = knownFirm(12, 'ZHANJIANG EVERGREEN AQUATIC PRODUCT', where, { feis: [3001000001] });

    // The duplicate scores higher: firm 12 at the postal code (0.8953), firm 13 in the city only (0.8653).
    const inCity = knownFirm(13, 'ZHANJIANG EVERGREEN AQUATIC PRODUCT', { city: 'Zhanjiang', country: 'CN' });
    expect(planLinks({ firms: [holder, inCity], records: [r] })).toEqual(
      ownFirm(r, [reviewOf(r, existing(12), 'second_fei', pluralAtPostalCode)]),
    );

    // A tie goes to second_fei, though firm 11, without an FEI, ranks first on its id.
    const atPostalCode = knownFirm(11, 'ZHANJIANG EVERGREEN AQUATIC PRODUCT', where);
    expect(planLinks({ firms: [holder, atPostalCode], records: [r] })).toEqual(
      ownFirm(r, [reviewOf(r, existing(12), 'second_fei', pluralAtPostalCode)]),
    );

    // The firm without an FEI scores higher: firm 6, a near name in the city (0.7464 + 0.12 = 0.8664), against firm 5,
    // a duplicate by address and city (0.8558).
    const plant = knownFirm(5, 'AGRO INDUSTRIAS SAN JUAN', sanJuanPlant, { feis: [3008880001] });
    const nearName = knownFirm(6, 'AGROINDUSTRIA SAN JUAN', { city: 'Chimaltenango', country: 'GT' });
    const sanJuan = refusal('r-2', '2024-03-11', 'AGROINDUSTRIAS SAN JUAN S.A.', sanJuanPlant, { fei: 3008880002 });
    expect(planLinks({ firms: [plant, nearName], records: [sanJuan] })).toEqual(
      ownFirm(sanJuan, [
        reviewOf(sanJuan, existing(6), 'score_band', {
          ...countryOnly,
          nameSim: expect.closeTo(0.9952, 4),
          cityMatch: true,
          parts: { name: 0.7464, location: 0.12, locationReason: 'city', product: 0, total: 0.8664 },
        }),
      ]),
    );
  });

  it('attaching to a link-band firm without an FEI still wins over any review', () => {
    // Firm 5 holds another FEI and is a duplicate by exact name, address and city: 1. Firm 6 has no FEI and a near name
    // at the address: 0.7464 + 0.25 = 0.9964, the link band, so it takes the FEI.
    const holder = knownFirm(5, 'AGROINDUSTRIAS SAN JUAN', sanJuanPlant, { feis: [3008880001] });
    const nearName = knownFirm(6, 'AGROINDUSTRIA SAN JUAN', sanJuanPlant);
    const r = refusal('r-1', '2024-03-11', 'AGROINDUSTRIAS SAN JUAN S.A.', sanJuanPlant, { fei: 3008880002 });

    expect(planLinks({ firms: [holder, nearName], records: [r] })).toEqual({
      newFirms: [],
      links: [linked(r, existing(6), 0.9964)],
      feis: [{ fei: 3008880002, firm: existing(6), firstSeen: '2024-03-11' }],
      reviews: [],
    });
  });

  it('opens score_band against a firm without an FEI when a link-band FEI holder matches by name alone', () => {
    // Firm 8 holds another FEI and scores 1 by its exact distinctive name in the same city, but without an address or a
    // postal code it is another plant. Firm 2 has no FEI and a near name in the city: 0.7406 + 0.12 = 0.8606.
    const holder = knownFirm(8, 'GURUDEV SPICES', { city: 'Unjha', country: 'IN' }, { feis: [3005550001] });
    const listed = knownFirm(2, 'GURUDEVA SPICES', { city: 'Unjha', country: 'IN' });
    const r = refusal(
      'r-1',
      '2024-04-20',
      'GURUDEV SPICES PVT LTD',
      { city: 'Unjha', country: 'India' },
      { fei: 3005550002 },
    );

    expect(planLinks({ firms: [holder, listed], records: [r] })).toEqual(
      ownFirm(r, [
        reviewOf(r, existing(2), 'score_band', {
          ...countryOnly,
          nameSim: 0.9875,
          cityMatch: true,
          parts: { name: 0.7406, location: 0.12, locationReason: 'city', product: 0, total: 0.8606 },
        }),
      ]),
    );
  });

  it('links the same exporter listed on three Import Alerts to one firm', () => {
    // Review Focus 2: the firm the first listing creates is a candidate for the next listing.
    const where: RawAddress = { line1: 'Plot 14, Sector 7, Korangi Industrial Area', city: 'Karachi', country: 'PK' };
    const first = listing('ia-16-120', '2019-08-01', 'KARACHI SEAFOOD EXPORTS', where, { commodityIds: [7] });
    const second = listing('ia-16-129', '2021-03-15', 'Karachi Seafood Exports (Pvt.) Ltd.', where, {
      commodityIds: [7],
    });
    const third = listing('ia-16-131', '2022-11-30', 'KARACHI SEAFOOD EXPORTS', where);

    expect(planLinks({ firms: [], records: [third, first, second] })).toEqual({
      newFirms: [newFirm(0, first)],
      links: [linked(first, created(0), 1), linked(second, created(0), 1), linked(third, created(0), 1)],
      feis: [],
      reviews: [],
    });
  });

  it('links an Australian producer to an FDA firm by exact distinctive name', () => {
    const fda = refusal(
      'r-1',
      '2024-02-10',
      'QINGDAO HAIDA FOODSTUFFS CO., LTD',
      { line1: '8 Jiaozhou Road', city: 'Qingdao', region: 'Shandong', postalCode: '266000', country: 'CN' },
      { fei: 3004440001, commodityIds: [5] },
    );
    // Australia names only the country. Its row is older than the refusal, but FDA records are matched first.
    const au = auRow(
      'au-2023-07-0042',
      '2023-07-12',
      'Qingdao Haida Foodstuffs Co Ltd',
      { country: 'China' },
      { commodityIds: [5] },
    );

    expect(planLinks({ firms: [], records: [au, fda] })).toEqual({
      newFirms: [newFirm(0, fda)],
      links: [linked(fda, created(0), 1), linked(au, created(0), 1)],
      feis: [{ fei: 3004440001, firm: created(0), firstSeen: '2024-02-10' }],
      reviews: [],
    });
  });

  it('never links across countries', () => {
    const firm = knownFirm(1, 'QINGDAO HAIDA FOODSTUFFS', { city: 'Qingdao', country: 'CN' }, { commodityIds: [5] });
    // The same distinctive name and even a city of the same name, but in Viet Nam.
    const vietnam = listing(
      'ia-1',
      '2024-01-08',
      'QINGDAO HAIDA FOODSTUFFS CO., LTD',
      { city: 'Qingdao', country: 'Viet Nam' },
      { commodityIds: [5] },
    );
    const china = auRow('au-1', '2024-02-01', 'Qingdao Haida Foodstuffs', { country: 'China' }, { commodityIds: [5] });

    expect(planLinks({ firms: [firm], records: [vietnam, china] })).toEqual({
      newFirms: [newFirm(0, vietnam)],
      links: [linked(vietnam, created(0), 1), linked(china, existing(1), 1)],
      feis: [],
      reviews: [],
    });
  });

  it('never auto-links a record with an unknown country', () => {
    const firm = knownFirm(1, 'QINGDAO HAIDA FOODSTUFFS', { city: 'Qingdao', country: 'CN' }, { commodityIds: [5] });
    // The name of firm 1, three times, with no country, an unrecognised one, and no address at all.
    const fda = refusal(
      'r-1',
      '2024-01-08',
      'QINGDAO HAIDA FOODSTUFFS',
      { city: 'Qingdao' },
      { fei: 3004440001, commodityIds: [5] },
    );
    const ia = listing(
      'ia-1',
      '2024-02-01',
      'QINGDAO HAIDA FOODSTUFFS',
      { city: 'Qingdao', country: 'Atlantis' },
      { commodityIds: [5] },
    );
    const au = auRow('au-1', '2024-03-01', 'Qingdao Haida Foodstuffs', null, { commodityIds: [5] });

    expect(planLinks({ firms: [firm], records: [au, ia, fda] })).toEqual({
      newFirms: [newFirm(0, fda), newFirm(1, ia), newFirm(2, au)],
      links: [linked(fda, created(0), 1), linked(ia, created(1), 1), linked(au, created(2), 1)],
      feis: [{ fei: 3004440001, firm: created(0), firstSeen: '2024-01-08' }],
      reviews: [],
    });
  });

  it('gives a legal-words-only name its own firm', () => {
    const where: RawAddress = { line1: 'Jalan Jenderal Sudirman Kav 52', city: 'Jakarta', country: 'ID' };
    const firm = knownFirm(4, 'PT Tbk', where, { commodityIds: [4] });
    const r = listing('ia-1', '2024-01-08', 'PT Tbk', where, { commodityIds: [4] });

    // "tbk" is a legal word, so it counts as no name: the same address and commodity reach only 0.25 + 0.03.
    expect(r.nameNorm).toBe('tbk');
    expect(planLinks({ firms: [firm], records: [r] })).toEqual({
      newFirms: [newFirm(0, r)],
      links: [linked(r, created(0), 1)],
      feis: [],
      reviews: [],
    });
  });

  it('sends a generic exact name in another city to review', () => {
    // With the record, 51 Pakistani names contain each word of "al rahman rice mills": not distinctive.
    const others = Array.from({ length: 50 }, (_, i) =>
      knownFirm(100 + i, `AL RAHMAN UNIT${i + 1} RICE MILLS`, { country: 'PK' }),
    );
    const firm = knownFirm(7, 'AL RAHMAN RICE MILLS', { city: 'Gujranwala', country: 'PK' }, { commodityIds: [3] });
    const r = listing(
      'ia-1',
      '2024-01-08',
      'Al Rahman Rice Mills',
      { city: 'Lahore', country: 'Pakistan' },
      { commodityIds: [3] },
    );

    // 0.75 + 0.03 + 0.03 = 0.81 (spec §8.2).
    expect(planLinks({ firms: [...others, firm], records: [r] })).toEqual({
      newFirms: [newFirm(0, r)],
      links: [linked(r, created(0), 1)],
      feis: [],
      reviews: [
        {
          source: 'import_alert',
          key: 'ia-1',
          firm: created(0),
          candidate: existing(7),
          score: 0.81,
          reason: 'score_band',
          evidence: {
            ...countryOnly,
            nameSim: 1,
            productOverlap: true,
            parts: { name: 0.75, location: 0.03, locationReason: 'same_country', product: 0.03, total: 0.81 },
          },
        },
      ],
    });
  });

  it("counts the run's records in the token frequencies", () => {
    // A first run, with no firm yet: only the records make the words of "al rahman rice mills" common (P3-D4).
    const others = Array.from({ length: 50 }, (_, i) =>
      listing(`ia-${100 + i}`, '2020-01-06', `AL RAHMAN ${i + 1} RICE MILLS`, { country: 'PK' }),
    );
    const gujranwala = listing(
      'ia-1',
      '2021-01-04',
      'AL RAHMAN RICE MILLS',
      { city: 'Gujranwala', country: 'PK' },
      { commodityIds: [3] },
    );
    const lahore = listing(
      'ia-2',
      '2022-01-03',
      'Al Rahman Rice Mills',
      { city: 'Lahore', country: 'Pakistan' },
      { commodityIds: [3] },
    );

    const plan = planLinks({ firms: [], records: [lahore, gujranwala, ...others] });
    // Every record gets its own firm: the 50 others first, by key, then Gujranwala (50) and Lahore (51).
    expect(plan.newFirms.map(({ key }) => key)).toEqual([...others.map(({ key }) => key), 'ia-1', 'ia-2']);
    expect(plan.reviews).toEqual([
      {
        source: 'import_alert',
        key: 'ia-2',
        firm: created(51),
        candidate: created(50),
        score: 0.81,
        reason: 'score_band',
        evidence: {
          ...countryOnly,
          nameSim: 1,
          productOverlap: true,
          parts: { name: 0.75, location: 0.03, locationReason: 'same_country', product: 0.03, total: 0.81 },
        },
      },
    ]);
  });

  it('counts the names of linked records and firms in a later run', () => {
    // A later run. The firm table holds 51 Pakistani firms whose names contain "rahman": 50 units, whose linked records
    // name them "AL RAHMAN UNIT<n> RICE MILLS", and Al Rahman Rice Mills in Gujranwala, whose record is linked too.
    const units = Array.from({ length: 50 }, (_, i) => knownFirm(100 + i, `AL RAHMAN UNIT${i + 1}`, { country: 'PK' }));
    const firm = knownFirm(7, 'AL RAHMAN RICE MILLS', { city: 'Gujranwala', country: 'PK' }, { commodityIds: [3] });
    const linkedRecords = [
      ...units.map((_, i) =>
        listing(`ia-${100 + i}`, '2020-01-06', `AL RAHMAN UNIT${i + 1} RICE MILLS`, { country: 'PK' }),
      ),
      listing(
        'ia-1',
        '2021-01-04',
        'AL RAHMAN RICE MILLS',
        { city: 'Gujranwala', country: 'PK' },
        { commodityIds: [3] },
      ),
    ];
    const r = listing(
      'ia-2',
      '2022-01-03',
      'Al Rahman Rice Mills',
      { city: 'Lahore', country: 'Pakistan' },
      { commodityIds: [3] },
    );
    // What loadLinkInput counts: every firm and every record, linked or not (P3-D4). 51 of these Pakistani names contain
    // each word of "al rahman rice mills"; the firms and the unlinked record alone give "rice" and "mills" only one.
    const frequencyNames = [...units, firm, ...linkedRecords, r].map(({ nameNorm, address }) => ({
      countryCode: address?.countryCode ?? null,
      nameNorm,
    }));

    // Not distinctive, as in the first run: 0.75 + 0.03 + 0.03 = 0.81, where a distinctive name would link at 1.
    expect(planLinks({ firms: [...units, firm], records: [r], frequencyNames })).toEqual({
      newFirms: [newFirm(0, r)],
      links: [linked(r, created(0), 1)],
      feis: [],
      reviews: [
        {
          source: 'import_alert',
          key: 'ia-2',
          firm: created(0),
          candidate: existing(7),
          score: 0.81,
          reason: 'score_band',
          evidence: {
            ...countryOnly,
            nameSim: 1,
            productOverlap: true,
            parts: { name: 0.75, location: 0.03, locationReason: 'same_country', product: 0.03, total: 0.81 },
          },
        },
      ],
    });
  });

  it("matches an FEI's refusals together, where its earliest refusal falls", () => {
    const where: RawAddress = { city: 'Bangkok', country: 'TH' };
    const older = refusal('r-1', '2020-03-02', 'ABC FOODS', where, { fei: 3001234567 });
    const between = refusal('r-2', '2022-04-01', 'ABC FOODS INTERNATIONAL', where);
    const newer = refusal('r-3', '2024-06-11', 'ABC FOODS INTERNATIONAL', where, { fei: 3001234567 });

    // The FEI's firm exists before the 2022 refusal, which has no FEI, is matched; so that refusal joins it.
    expect(planLinks({ firms: [], records: [newer, between, older] })).toEqual({
      newFirms: [newFirm(0, newer, '2020-03-02')],
      links: [linked(older, created(0), 1), linked(newer, created(0), 1), linked(between, created(0), 1)],
      feis: [{ fei: 3001234567, firm: created(0), firstSeen: '2020-03-02' }],
      reviews: [],
    });
  });

  it('links to the earliest-added firm when two firms score the same', () => {
    // Two firms under one name in one city, given in reverse id order: firm 4 was added first.
    const later = knownFirm(9, 'HUNG VUONG', { city: 'Cao Lanh', country: 'VN' });
    const earlier = knownFirm(4, 'HUNG VUONG', { city: 'Cao Lanh', country: 'VN' });
    const r = listing('ia-1', '2024-01-08', 'HUNG VUONG CORPORATION', { city: 'Cao Lanh', country: 'Viet Nam' });

    expect(planLinks({ firms: [later, earlier], records: [r] })).toEqual({
      newFirms: [],
      links: [linked(r, existing(4), 1)],
      feis: [],
      reviews: [],
    });
  });

  it("adds a linked record's commodities to its firm", () => {
    const where: RawAddress = { city: 'Zhanjiang', country: 'CN' };
    const firm = knownFirm(12, 'ZHANJIANG EVERGREEN AQUATIC PRODUCT', where, { commodityIds: [1] });
    const exact = listing('ia-1', '2024-01-08', 'ZHANJIANG EVERGREEN AQUATIC PRODUCT CO., LTD.', where, {
      commodityIds: [2],
    });
    const plural = listing('ia-2', '2024-02-01', 'ZHANJIANG EVERGREEN AQUATIC PRODUCTS', where, { commodityIds: [2] });

    // Commodity 2 reaches firm 12 with the first listing, so the second shares it: 0.8953, not 0.8653.
    expect(planLinks({ firms: [firm], records: [plural, exact] })).toEqual({
      newFirms: [newFirm(0, plural)],
      links: [linked(exact, existing(12), 1), linked(plural, created(0), 1)],
      feis: [],
      reviews: [
        {
          source: 'import_alert',
          key: 'ia-2',
          firm: created(0),
          candidate: existing(12),
          score: 0.8953,
          reason: 'score_band',
          evidence: pluralInSameCity,
        },
      ],
    });
  });

  it('leaves its input as it is', () => {
    const where: RawAddress = { city: 'Zhanjiang', postalCode: '524000', country: 'CN' };
    // Both lists out of order, and both firms gain commodities, firm 12 an FEI too: on the engine's copies only.
    const firms = [
      knownFirm(12, 'ZHANJIANG EVERGREEN AQUATIC PRODUCT', where, { commodityIds: [5] }),
      knownFirm(3, 'SHANDONG LONGDA FOOD', { city: 'Laiyang', country: 'CN' }, { feis: [3002345678] }),
    ];
    const records = [
      refusal('r-2', '2024-02-01', 'ZHANJIANG EVERGREEN AQUATIC PRODUCTS CO LTD', where, {
        fei: 3001000001,
        commodityIds: [5, 6],
      }),
      refusal('r-1', '2023-01-05', 'SHANDONG LONGDA FOOD CO LTD', null, { fei: 3002345678, commodityIds: [7] }),
    ];
    const input = { firms, records };
    const before = structuredClone(input);

    expect(planLinks(input).feis).toEqual([{ fei: 3001000001, firm: existing(12), firstSeen: '2024-02-01' }]);
    expect(input).toEqual(before);
  });

  it('is deterministic', () => {
    const firms = [
      knownFirm(3, 'SHANDONG LONGDA FOOD', { city: 'Laiyang', country: 'CN' }, { feis: [3002345678] }),
      knownFirm(12, 'ZHANJIANG EVERGREEN AQUATIC PRODUCT', { city: 'Zhanjiang', country: 'CN' }, { commodityIds: [5] }),
      knownFirm(7, 'HUNG VUONG', { city: 'Cao Lanh', country: 'VN' }),
      knownFirm(9, 'HUNG VUONG', { city: 'Cao Lanh', country: 'VN' }),
    ];
    const bangkok: RawAddress = { city: 'Bangkok', country: 'TH' };
    const karachi: RawAddress = { city: 'Karachi', country: 'PK' };
    const records = [
      refusal(
        'r-1',
        '2024-01-15',
        'SHANDONG LONGDA FOOD CO LTD',
        { city: 'Laiyang', country: 'CN' },
        { fei: 3002345678 },
      ),
      refusal('r-2', '2024-03-02', 'LONGDA FOODSTUFF GROUP', null, { fei: 3002345678 }),
      refusal('r-3', '2020-03-02', 'ABC FOODS', bangkok, { fei: 3001234567, commodityIds: [2] }),
      refusal('r-4', '2022-04-01', 'ABC FOODS INTERNATIONAL', bangkok),
      refusal('r-5', '2024-06-11', 'ABC FOODS INTERNATIONAL', bangkok, { fei: 3001234567, commodityIds: [3] }),
      listing('ia-1', '2021-03-15', 'KARACHI SEAFOOD EXPORTS', karachi, { commodityIds: [7] }),
      listing('ia-2', '2021-03-15', 'Karachi Seafood Exports (Pvt.) Ltd.', karachi),
      listing('ia-3', '2019-08-01', 'KARACHI SEAFOOD EXPORTS', karachi),
      listing(
        'ia-4',
        '2024-05-06',
        'ZHANJIANG EVERGREEN AQUATIC PRODUCTS CO., LTD',
        { city: 'Zhanjiang', country: 'CN' },
        { commodityIds: [5] },
      ),
      listing('ia-5', '2023-01-01', 'HUNG VUONG CORPORATION', { city: 'Cao Lanh', country: 'Viet Nam' }),
      auRow('au-1', '2023-07-12', 'Abc Foods International', { country: 'Thailand' }),
      auRow('au-2', '2023-07-12', 'Karachi Seafood Exports', null),
    ];

    const plan = planLinks({ firms, records });
    // The fixture reaches every part of a plan: 4 new firms, 12 links, 1 new FEI and 1 review.
    expect([plan.newFirms.length, plan.links.length, plan.feis.length, plan.reviews.length]).toEqual([4, 12, 1, 1]);
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(planLinks({ firms: shuffled(firms, seed), records: shuffled(records, seed) })).toEqual(plan);
    }
  });
});

describe('countryTokenFrequencies', () => {
  it('counts, per country, the distinct names that contain each token', () => {
    expect(
      countryTokenFrequencies([
        { countryCode: 'PK', nameNorm: 'al rahman rice mills' },
        { countryCode: 'PK', nameNorm: 'al rahman rice mills' }, // the same name again counts once
        { countryCode: 'PK', nameNorm: 'al noor al rahman' }, // so does a token twice in one name
        { countryCode: 'IN', nameNorm: 'al rahman rice mills' },
        { countryCode: null, nameNorm: 'al rahman rice mills' }, // no country: ignored
      ]),
    ).toEqual(
      new Map([
        [
          'PK',
          new Map([
            ['al', 2],
            ['rahman', 2],
            ['rice', 1],
            ['mills', 1],
            ['noor', 1],
          ]),
        ],
        [
          'IN',
          new Map([
            ['al', 1],
            ['rahman', 1],
            ['rice', 1],
            ['mills', 1],
          ]),
        ],
      ]),
    );
  });
});

describe('rankCandidates', () => {
  const r = listing(
    'ia-1',
    '2024-01-08',
    'ZHANJIANG EVERGREEN AQUATIC PRODUCTS',
    { city: 'Zhanjiang', postalCode: '524000', country: 'CN' },
    { commodityIds: [5] },
  );

  /** An index of Chinese firms sharing the record's commodity, each firm's `order` being its place in `firms`. */
  function chineseFirms(...firms: [name: string, where: RawAddress][]): CandidateIndex<FirmView> {
    const index = new CandidateIndex<FirmView>();
    firms.forEach(([name, where], order) => {
      const nameNorm = normalizeName(name).primary;
      index.add(nameNorm, {
        ref: existing(100 + order),
        nameNorm,
        address: normalizeAddress(where),
        commodityIds: [5],
        feis: [],
        order,
      });
    });
    return index;
  }
  const index = chineseFirms(
    ['ZHANJIANG EVERGREEN AQUATIC PRODUCTS', { city: 'Guangzhou', country: 'CN' }],
    ['ZHANJIANG EVERGREEN AQUATIC PRODUCT', { city: 'Zhanjiang', postalCode: '524000', country: 'CN' }],
    ['ZHANJIANG EVERGREEN AQUATIC PRODUCTS', { city: 'Guangzhou', country: 'CN' }],
  );
  /** Every word of the record's name is in 50 Chinese firm names, so the name is not distinctive. */
  const common = new Map(['zhanjiang', 'evergreen', 'aquatic', 'products'].map((token) => [token, 50]));

  it('scores every candidate and ranks them by score, then by order', () => {
    const ranked = rankCandidates(r, index, common);

    // The exact names come first by trigram similarity; in another city they score only 0.75 + 0.03 + 0.03.
    expect(ranked.map(({ firm, score }) => [firm.order, score])).toEqual([
      [1, 0.9253],
      [0, 0.81],
      [2, 0.81],
    ]);
    expect(ranked[0]).toMatchObject({
      evidence: { ...countryOnly, nameSim: 0.99375, postalMatch: true, cityMatch: true, productOverlap: true },
      parts: { name: 0.7453, location: 0.15, locationReason: 'postal_code', product: 0.03, total: 0.9253 },
    });
  });

  it("gives the distinctive-name bonus when the name's rarest word is in fewer than 50 of the country's names", () => {
    const ranked = rankCandidates(r, index, new Map([...common, ['products', 49]]));

    expect(ranked.map(({ firm, score }) => [firm.order, score])).toEqual([
      [0, 1],
      [2, 1],
      [1, 0.9253],
    ]);
  });

  it('has no candidates for a record without a country, or without an index', () => {
    expect(rankCandidates({ ...r, address: null }, index, common)).toEqual([]);
    expect(rankCandidates({ ...r, address: normalizeAddress({ city: 'Zhanjiang' }) }, index, common)).toEqual([]);
    expect(rankCandidates(r, undefined, common)).toEqual([]);
  });
});
