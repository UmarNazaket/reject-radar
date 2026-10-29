import type { Provider } from '@angular/core';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';

/**
 * Outlined form fields whose hint and error lines take space only when shown. Provided by the two layouts rather than
 * at the root, so Material's form field code stays out of the first download.
 */
export const FORM_FIELD_DEFAULTS: Provider = {
  provide: MAT_FORM_FIELD_DEFAULT_OPTIONS,
  useValue: { appearance: 'outline', subscriptSizing: 'dynamic' },
};
