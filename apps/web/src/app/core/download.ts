import { HttpClient, HttpErrorResponse, type HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/**
 * Fetches a file from the API and saves it as `fileName`. A failed download's body is a Blob, so it is read back as the
 * JSON error it is, and `errorMessage` can show its code.
 */
export async function downloadFile(http: HttpClient, url: string, params: HttpParams, fileName: string): Promise<void> {
  let blob: Blob;
  try {
    blob = await firstValueFrom(http.get(url, { params, responseType: 'blob' }));
  } catch (error) {
    if (!(error instanceof HttpErrorResponse && error.error instanceof Blob)) throw error;
    let body: unknown = null;
    try {
      body = JSON.parse(await error.error.text());
    } catch {
      // Not JSON (a proxy's page, for example): the status alone picks the message.
    }
    throw new HttpErrorResponse({ error: body, status: error.status, statusText: error.statusText, headers: error.headers, url: error.url ?? undefined });
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  // Revoked a moment later: some browsers start reading the file only after the click returns.
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
