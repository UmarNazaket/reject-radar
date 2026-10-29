import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { LoginRequest, MeResponse, Role } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';
import { I18n } from './i18n';

/**
 * Who is signed in, loaded from `GET /v1/me`. The session itself lives in the API's HttpOnly cookies; this only mirrors
 * it for the screens. `undefined` until the first load finishes, `null` when signed out.
 */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly http = inject(HttpClient);
  private readonly i18n = inject(I18n);
  private readonly me = signal<MeResponse | null | undefined>(undefined);
  private loading: Promise<MeResponse | null> | null = null;

  readonly user = computed(() => this.me()?.user ?? null);
  readonly org = computed(() => this.me()?.org ?? null);
  readonly role = computed<Role | null>(() => this.me()?.role ?? null);
  readonly signedIn = computed(() => !!this.me());

  /** Loads the session once; later calls share the first load. */
  load(): Promise<MeResponse | null> {
    this.loading ??= this.fetchMe();
    return this.loading;
  }

  /** Loads the session again, after something on the server changed it (an email verified). */
  reload(): Promise<MeResponse | null> {
    this.loading = this.fetchMe();
    return this.loading;
  }

  async login(body: LoginRequest): Promise<void> {
    this.start(await firstValueFrom(this.http.post<MeResponse>(apiUrl('/v1/auth/login'), body)));
  }

  /** A sign-in that happened elsewhere (accepting an invite) answered with the new session. */
  start(me: MeResponse): void {
    this.set(me);
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post(apiUrl('/v1/auth/logout'), {}));
    } finally {
      this.clear();
    }
  }

  /** Called when the API says the session has ended. */
  clear(): void {
    this.me.set(null);
    this.loading = Promise.resolve(null);
  }

  /** Changes the language on screen and, when signed in, on the account, so emails follow. */
  async setLocale(locale: MeResponse['user']['locale']): Promise<void> {
    await this.i18n.use(locale);
    if (this.signedIn()) this.set(await firstValueFrom(this.http.patch<MeResponse>(apiUrl('/v1/me'), { locale })));
  }

  private set(me: MeResponse): void {
    this.me.set(me);
    this.loading = Promise.resolve(me);
    if (me.user.locale !== this.i18n.locale()) void this.i18n.use(me.user.locale);
  }

  private async fetchMe(): Promise<MeResponse | null> {
    try {
      const me = await firstValueFrom(this.http.get<MeResponse>(apiUrl('/v1/me')));
      this.set(me);
      return me;
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.me.set(null);
        return null;
      }
      // The API could not answer: the next navigation asks again.
      this.loading = null;
      throw error;
    }
  }
}
