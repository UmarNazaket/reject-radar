import { HttpErrorResponse } from '@angular/common/http';
import type { I18n } from './i18n';
import { FormState } from './form-state';

// Prefixed: `errorMessage` reads an untranslated `errors.*` key as missing.
const i18n = { t: (key: string) => `text:${key}` } as unknown as I18n;
const apiError = (code: string, status = 403) => new HttpErrorResponse({ status, error: { code, message: code } });

describe('FormState', () => {
  it('marks a plan error for the link to the plans, and clears it on the next submit', async () => {
    const form = new FormState(i18n);
    await form.run(() => Promise.reject(apiError('PLAN_LIMIT_REACHED')));
    expect(form.error()).toBe('text:errors.PLAN_LIMIT_REACHED');
    expect(form.upgrade()).toBe(true);

    await form.run(() => Promise.reject(apiError('PLAN_UPGRADE_REQUIRED')));
    expect(form.upgrade()).toBe(true);

    await form.run(() => Promise.reject(apiError('CONFLICT', 409)));
    expect(form.upgrade()).toBe(false);

    await form.run(() => Promise.reject(apiError('PLAN_LIMIT_REACHED')));
    await form.run(() => Promise.resolve());
    expect([form.error(), form.upgrade()]).toEqual([null, false]);
  });
});
