import { toCsvRow } from './csv';

describe('toCsvRow', () => {
  it('quotes by RFC 4180 and neutralises a formula (P5-D16)', () => {
    expect(toCsvRow(['=HYPERLINK("http://x","y")', 'a,b', null, 3])).toBe('"\'=HYPERLINK(""http://x"",""y"")","a,b",,3');
  });

  it.each([['-5'], ['+1'], ['@a'], ['\tx'], ['\rx'], ['=1+1']])('puts a quote in front of %j', (text) => {
    const row = toCsvRow([text]);
    expect(row.replace(/^"|"$/g, '').startsWith("'" + text)).toBe(true);
  });

  it('leaves plain text, and a minus or plus that is not first, alone', () => {
    expect(toCsvRow(['plain', 'a-b', 'a=b', ''])).toBe('plain,a-b,a=b,');
  });

  it('quotes a cell with a quote, a comma or a line break, and doubles the quotes', () => {
    expect(toCsvRow(['say "hi"', 'one\ntwo', 'x,y'])).toBe('"say ""hi""","one\ntwo","x,y"');
  });

  it('writes with a semicolon when asked, quoting a cell that holds one; a comma then needs no quotes', () => {
    expect(toCsvRow(['a;b', 'x,y', null, 3, '=1'], ';')).toBe(`"a;b";x,y;;3;'=1`);
    expect(toCsvRow(['say "hi"', 'one\ntwo'], ';')).toBe('"say ""hi""";"one\ntwo"');
    expect(toCsvRow(['a;b', 'x,y'])).toBe('a;b,"x,y"');
  });

  it('writes numbers as they are', () => {
    expect(toCsvRow([0, 12, -3.5])).toBe('0,12,-3.5');
  });

  it('writes an empty row as an empty line', () => {
    expect(toCsvRow([])).toBe('');
  });
});
