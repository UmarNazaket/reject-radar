import { normalizeHeader } from './read-csv-summary';

export interface FieldCheck {
  missing: string[];
  extra: string[];
}

export function checkFields(actual: readonly string[], expected: readonly string[]): FieldCheck {
  const actualSet = new Set(actual.map(normalizeHeader));
  const expectedSet = new Set(expected.map(normalizeHeader));
  return {
    missing: expected.filter((field) => !actualSet.has(normalizeHeader(field))),
    extra: actual.filter((field) => !expectedSet.has(normalizeHeader(field))),
  };
}
