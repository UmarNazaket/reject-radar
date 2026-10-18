import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isFoodAlert, parseAlertIndex } from './parse-index';
import { PageStructureError, parseAlertPage } from './parse-page';

const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
const BASE = 'https://www.accessdata.fda.gov/cms_ia/ialist.html';
const URL_99_19 = 'https://www.accessdata.fda.gov/cms_ia/importalert_263.html';

describe('parseAlertIndex', () => {
  const indexHtml = fixture('ialist.html');
  const entries = parseAlertIndex(indexHtml, BASE);

  it('parses the index', () => {
    expect(entries).toHaveLength(154);
    const e = entries.find((x) => x.number === '99-19');
    expect(e).toMatchObject({ alertType: 'DWPE', publishedOn: '2026-10-09' });
    expect(e?.url).toBe(URL_99_19);
    expect(e?.title).toBe('Detention Without Physical Examination of Food Products Due to the Presence of Salmonella');
    expect(entries.every((x) => x.title !== '')).toBe(true);
  });

  it('marks food alerts', () => {
    for (const number of ['16-131', '99-08', '99-19', '54-01', '71-02']) {
      expect(isFoodAlert({ number, title: 'Detention Without Physical Examination of Foods' })).toBe(true);
    }
    for (const number of ['66-40', '89-04', '98-01', '53-17']) {
      expect(isFoodAlert({ number, title: 'Detention Without Physical Examination of Foods' })).toBe(false);
    }
    expect(isFoodAlert({ number: '99-32', title: 'Detention of Drug Products From Firms' })).toBe(false);
    expect(isFoodAlert({ number: '99-35', title: 'Detention of Medical Devices' })).toBe(false);
  });

  const expectStructureError = (html: string) => {
    let error: unknown;
    try {
      parseAlertIndex(html, BASE);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PageStructureError);
    expect((error as PageStructureError).sample).toBe(html);
  };

  it('rejects an index without rows', () => {
    expectStructureError(indexHtml.replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>'));
  });

  it('rejects an index whose table headers were renamed', () => {
    const renamed = indexHtml.replace('Import Alert Number', 'Alert No.');
    expect(renamed).not.toBe(indexHtml);
    expectStructureError(renamed);
  });

  it('rejects an index with a malformed four-cell row', () => {
    const broken = indexHtml.replace('<td>99-19</td>', '<td>nineteen</td>');
    expect(broken).not.toBe(indexHtml);
    expectStructureError(broken);
    const noLink = indexHtml.replace(/<a href="importalert_263.html">([\s\S]*?)<\/a>/, '$1');
    expect(noLink).not.toBe(indexHtml);
    expectStructureError(noLink);
  });
});

describe('parseAlertPage', () => {
  const html = fixture('99-19.html');
  const alert = parseAlertPage(html, URL_99_19);

  it('parses alert header and sections', () => {
    expect(alert.number).toBe('99-19');
    expect(alert.title).toBe('Detention Without Physical Examination of Food Products Due to the Presence of Salmonella');
    expect(alert.publishedOn).toBe('2026-10-09');
    expect(alert.alertType).toBe('DWPE');
    expect(alert.chargeText).toContain('Salmonella');
    expect(alert.reasonText).toContain('\n');
    expect(alert.productText).toBe('See Red List');
    expect(alert.guidanceText).not.toBeNull();
    expect(alert.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(alert.textSha256).toBe(parseAlertPage(html, URL_99_19).textSha256);
    for (const text of [alert.reasonText, alert.guidanceText, alert.chargeText]) expect(text).not.toMatch(/<\/?[a-z]/i);
  });

  it('parses red-list firms and products', () => {
    expect(alert.listings.length).toBe(11);
    expect(alert.listings.every((l) => l.list === 'red')).toBe(true);
    expect(alert.listings[0]).toMatchObject({
      list: 'red',
      firmName: 'Mohamad Mahroof & Mahmood Haidar',
      countryName: 'AFGHANISTAN',
      countryCode: 'AF',
      city: 'Herat',
      region: null,
      listedOn: '2014-11-07',
    });
    expect(alert.listings[0].products).toHaveLength(5);
    expect(alert.listings[0].products[0]).toMatchObject({
      productCode: '24T--99',
      industryCode: '24',
      productName: 'Leaf & Stem Vegetables, N.E.C.',
      description: 'Fenugreek Leaves (Dried)',
      listedOn: '2014-11-07',
    });
    const albania = alert.listings.find((l) => l.countryName === 'ALBANIA');
    expect(albania).toMatchObject({ countryCode: 'AL', city: 'Tirana', region: 'Al-Tr' });
    expect(albania?.products[0]).toMatchObject({ notes: '7/14/05 | Problems: SALMONELLA;', problems: ['SALMONELLA'] });
  });

  it('keeps notes and problems', () => {
    const page = parseAlertPage(fixture('99-08.html'), 'https://www.accessdata.fda.gov/cms_ia/importalert_259.html');
    const product = page.listings
      .flatMap((l) => l.products)
      .find((p) => p.notes?.includes('Problem: PHOSALONE'));
    expect(product).toBeDefined();
    expect(product?.problems).toContain('FENITROTHION');
    expect(product?.notes).toBe('Problem: PHOSALONE | Problems: FENITROTHION;');
    expect(product?.notes?.length).toBeLessThanOrEqual(1000);
    expect(page.listings.flatMap((l) => l.products).every((p) => (p.notes ?? '').length <= 1000)).toBe(true);
  });

  it('cuts a long Notes value to 1,000 characters', () => {
    const long = 'x'.repeat(1500);
    const marker = '<div>Desc: Fenugreek Leaves (Dried)</div>';
    expect(html).toContain(marker);
    const page = parseAlertPage(html.replace(marker, `${marker}<div>Notes: ${long}</div>`), URL_99_19);
    const product = page.listings[0].products[0];
    expect(product.problems).toEqual([]);
    expect(product.notes).toHaveLength(1000);
    expect(product.notes?.startsWith('xxx')).toBe(true);
  });

  it('parses a green-only alert', () => {
    const page = parseAlertPage(fixture('16-131.html'), 'https://www.accessdata.fda.gov/cms_ia/importalert_33.html');
    expect(page.number).toBe('16-131');
    expect(page.listings).toHaveLength(21);
    expect(page.listings.every((l) => l.list === 'green')).toBe(true);
    expect(page.listings[0]).toMatchObject({ countryCode: 'CN', region: 'Guangdong', city: 'Zhanjiang' });
  });

  it('accepts an alert without lists', () => {
    const page = parseAlertPage(fixture('countrywide.html'), URL_99_19);
    expect(page.listings).toEqual([]);
    expect(page.number).toBe('99-19');
  });

  it('rejects a page with firm blocks but no list anchor', () => {
    const broken = fixture('broken-no-anchor.html');
    let error: unknown;
    try {
      parseAlertPage(broken, URL_99_19);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PageStructureError);
    expect((error as PageStructureError).message).toContain('RedFirm');
    expect((error as PageStructureError).sample).toBe(broken);
  });

  it('rejects a parse that loses firms', () => {
    const lossy = html.replace(
      '<div class="div-info">',
      '<div class="div-info"><div class="clear">No name, Nowhere</div></div><div class="div-info">',
    );
    expect(() => parseAlertPage(lossy, URL_99_19)).toThrow(PageStructureError);
  });

  it('rejects a page whose number differs from its heading', () => {
    expect(() => parseAlertPage(html.replace('<h1>Import Alert 99-19</h1>', '<h1>Import Alert 99-20</h1>'), URL_99_19)).toThrow(
      PageStructureError,
    );
  });

  it('treats NA as not available', () => {
    const page = parseAlertPage(html.replace('<h4>ALBANIA</h4>', '<h4>NA</h4>'), URL_99_19);
    const listing = page.listings.find((l) => l.countryName === 'NA');
    expect(listing).toBeDefined();
    expect(listing?.countryCode).toBeNull();
  });
});
