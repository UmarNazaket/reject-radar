import { signal } from '@angular/core';
import { errorMessage } from './errors';
import type { I18n } from './i18n';

/** A form's submit state: busy while the request runs, then the error message in the user's language. */
export class FormState {
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor(private readonly i18n: I18n) {}

  async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
    } catch (error) {
      this.error.set(errorMessage(this.i18n, error));
    } finally {
      this.busy.set(false);
    }
  }
}
