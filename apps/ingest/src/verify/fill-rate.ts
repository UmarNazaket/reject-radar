export type FillRates = Record<string, number>;

/** Counts rows and, per column, how many rows have a non-blank value. */
export class FillRateCounter {
  private total = 0;
  private readonly filled = new Map<string, number>();

  constructor(private readonly columns: readonly string[]) {
    for (const column of columns) this.filled.set(column, 0);
  }

  add(row: Record<string, string | undefined>): void {
    this.total++;
    for (const column of this.columns) {
      if ((row[column] ?? '').trim() !== '') this.filled.set(column, (this.filled.get(column) ?? 0) + 1);
    }
  }

  result(): { total: number; rates: FillRates } {
    const rates: FillRates = {};
    for (const column of this.columns) {
      const filled = this.filled.get(column) ?? 0;
      rates[column] = this.total === 0 ? 0 : Math.round((filled / this.total) * 10000) / 10000;
    }
    return { total: this.total, rates };
  }
}
