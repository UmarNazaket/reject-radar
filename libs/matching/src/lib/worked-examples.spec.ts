import { buildLinkEvidence, decideLink, type LinkEvidence, linkScore, type MatchRecord } from './link-score';
import { normalizeAddress, type RawAddress } from './normalize-address';
import { normalizeName } from './normalize-name';

/** A record as the linker sees it: name and address through the real normalisers, and the commodities it carries. */
function record(rawName: string, address: RawAddress | null, commodityIds: number[]): MatchRecord {
  return { nameNorm: normalizeName(rawName).primary, address: normalizeAddress(address), commodityIds };
}

/** Evidence → score → decision, exactly as the linker takes them. */
function link(a: MatchRecord, b: MatchRecord, isDistinctive: boolean) {
  const score = linkScore(buildLinkEvidence(a, b, { isDistinctive }));
  return { score, decision: decideLink(score) };
}

const evidence: LinkEvidence = {
  nameSim: 0,
  sameCountry: true,
  addressMatch: false,
  exactDistinctiveName: false,
  postalMatch: false,
  cityMatch: false,
  regionMatch: false,
  productOverlap: false,
};

describe('spec §8.2 worked examples, end to end', () => {
  describe('from real records through buildLinkEvidence', () => {
    it('exact name, same city, shared commodity: 0.75 + 0.12 + 0.03 = 0.90 → link', () => {
      const incoming = record('Haji Bashir Ahmad & Sons', { city: 'Karachi', country: 'Pakistan' }, [3]);
      const firm = record('HAJI BASHIR AHMAD AND SONS', { city: 'Karachi', country: 'PK' }, [3, 7]);
      expect(link(incoming, firm, false)).toEqual({ score: 0.9, decision: 'link' });
    });

    it('exact but generic name, same country only, shared commodity: 0.75 + 0.03 + 0.03 = 0.81 → review', () => {
      const incoming = record('Al-Rehman Rice Mills (Pvt.) Ltd.', { city: 'Lahore', country: 'Pakistan' }, [3]);
      const firm = record('AL RAHMAN RICE MILLS', { city: 'Gujranwala', country: 'Pakistan' }, [3]);
      expect(incoming.nameNorm).toBe('al rahman rice mills');
      expect(firm.nameNorm).toBe('al rahman rice mills');
      expect(link(incoming, firm, false)).toEqual({ score: 0.81, decision: 'review' });
    });

    it('exact distinctive name on an Australian record with no address, shared commodity: 1.00 (capped) → link', () => {
      // The Australian list gives the producer's country and nothing else.
      const australian = record('Qingdao Haida Foodstuffs Co., Ltd.', { country: 'China' }, [5]);
      const firm = record(
        'QINGDAO HAIDA FOODSTUFFS CO., LTD',
        { line1: 'No. 8 Jiaozhou Road', city: 'Qingdao', region: 'Shandong', postalCode: '266000', country: 'CN' },
        [5, 9],
      );
      expect(australian.address).toMatchObject({ countryCode: 'CN', city: null, addressNorm: null });
      expect(link(australian, firm, true)).toEqual({ score: 1, decision: 'link' });
    });

    it('exact distinctive name in a different country: 0 → new firm', () => {
      const china = record('Qingdao Haida Foodstuffs Co., Ltd.', { city: 'Qingdao', country: 'China' }, [5]);
      const vietnam = record('QINGDAO HAIDA FOODSTUFFS CO., LTD', { city: 'Qingdao', country: 'Viet Nam' }, [5]);
      expect(link(china, vietnam, true)).toEqual({ score: 0, decision: 'new' });
    });
  });

  describe('from evidence', () => {
    it('name similarity 0.85, same postal code, shared commodity: 0.6375 + 0.15 + 0.03 = 0.8175 → review', () => {
      const score = linkScore({ ...evidence, nameSim: 0.85, postalMatch: true, productOverlap: true });
      expect({ score, decision: decideLink(score) }).toEqual({ score: 0.8175, decision: 'review' });
    });

    it('name similarity 0.92, address match: 0.69 + 0.25 = 0.94 → link', () => {
      const score = linkScore({ ...evidence, nameSim: 0.92, addressMatch: true });
      expect({ score, decision: decideLink(score) }).toEqual({ score: 0.94, decision: 'link' });
    });
  });
});
