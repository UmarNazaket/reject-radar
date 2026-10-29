import { BidiModule } from '@angular/cdk/bidi';
import { Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { textDirection } from '@rejectradar/contracts/locales';
import { I18n } from './core/i18n';

/** `dir` on the root tells Material and the CDK the text direction, and updates them when the language changes. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, BidiModule],
  template: '<div [dir]="dir()"><router-outlet /></div>',
})
export class App {
  private readonly i18n = inject(I18n);
  protected readonly dir = computed(() => textDirection(this.i18n.locale()));
}
