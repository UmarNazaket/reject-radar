import { signal } from '@angular/core';
import { errorMessage, needsUpgrade } from './errors';
import type { I18n } from './i18n';

/** A form's submit state: busy while the request runs, then the error message in the user's language. */
export class FormState {
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** Whether the error is a plan error, for the link to the plans. */
  readonly upgrade = signal(false);

  constructor(
    private readonly i18n: I18n,
    private readonly message: (i18n: I18n, error: unknown) => string = errorMessage,
  ) {}

  async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.upgrade.set(false);
    try {
      await action();
    } catch (error) {
      this.error.set(this.message(this.i18n, error));
      this.upgrade.set(needsUpgrade(error));
    } finally {
      this.busy.set(false);
    }
  }
}
