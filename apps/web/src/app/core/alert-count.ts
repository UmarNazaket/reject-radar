import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import type { AlertsResponse } from '@rejectradar/contracts';
import { apiUrl } from './api';

/** The account's unread alerts, for the number in the top bar; the alerts page keeps it current as it loads and marks. */
@Injectable({ providedIn: 'root' })
export class AlertCount {
  private readonly http = inject(HttpClient);
  readonly unread = signal<number | null>(null);

  refresh(): void {
    this.http.get<AlertsResponse>(apiUrl('/v1/alerts'), { params: { unread: 'true' } }).subscribe({
      next: (res) => this.unread.set(res.unread),
      // The count is a hint; the top bar shows none rather than an error.
      error: () => this.unread.set(null),
    });
  }
}
