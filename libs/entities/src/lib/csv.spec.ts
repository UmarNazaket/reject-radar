import { parse } from 'csv-parse/sync';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('writes the header row, then each row in column order, every line ended by a line feed', () => {
    const rows = [
      { name: 'Gurudev Spices', id: '1' },
      { name: '', id: '2' },
    ];

    expect(toCsv(['id', 'name'], rows)).toBe('id,name\n1,Gurudev Spices\n2,\n');
  });

  it('writes only the header row when there are no rows', () => {
    expect(toCsv(['id', 'name'], [])).toBe('id,name\n');
  });

  it('quotes a field with a comma, a double quote or a line break, doubling its double quotes', () => {
    const rows = [
      { name: 'Fujian Dongwei Food Co., Ltd.' },
      { name: 'Golden "GH" Harvest' },
      { name: 'NO.5 Fulu Centre Road\nFUQING' },
      { name: 'Unit 4\r\nKorangi' },
      { name: ' Siam Ocean ' },
    ];

    expect(toCsv(['name'], rows)).toBe(
      'name\n' +
        '"Fujian Dongwei Food Co., Ltd."\n' +
        '"Golden ""GH"" Harvest"\n' +
        '"NO.5 Fulu Centre Road\nFUQING"\n' +
        '"Unit 4\r\nKorangi"\n' +
        ' Siam Ocean \n',
    );
  });

  it('reads back as it was written', () => {
    const rows = [
      { name: 'Al "Noor", Rice\r\nMills', note: ' spaced ' },
      { name: '', note: '"' },
    ];

    expect(parse(toCsv(['name', 'note'], rows), { columns: true })).toEqual(rows);
  });
});
