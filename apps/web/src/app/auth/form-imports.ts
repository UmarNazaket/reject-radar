import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { Alert } from '../layout/alert';

/** What every sign-in form uses. */
export const FORM_IMPORTS = [FormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatButtonModule, Alert] as const;
