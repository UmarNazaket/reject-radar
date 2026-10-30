import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AdminFirmResponse } from '@rejectradar/contracts';
import { AdminFirm } from './admin-firm';

// Lets a reload send its request; `whenStable` would wait for a response the test has not flushed yet.
const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
};

const FIRM: AdminFirmResponse = {
  firm: { id: 7, displayName: 'Zarfeen Rice Mills', countryCode: 'PK', city: 'lahore', feis: [], records: 2, mergedInto: null },
  records: [
    { source: 'import_alert', key: 'l-1', fei: null, firmName: 'Zarfeen Rice Mills', address: null, seenOn: '2026-09-01' },
    { source: 'au_ifis', key: 'a-1', fei: null, firmName: 'Zarfeen Rice', address: null, seenOn: '2026-08-01' },
  ],
};

describe('AdminFirm', () => {
  let http: HttpTestingController;
  let confirm: jest.SpyInstance;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    confirm = jest.spyOn(window, 'confirm');
  });

  afterEach(() => {
    http.verify();
    confirm.mockRestore();
  });

  const render = async () => {
    const fixture = TestBed.createComponent(AdminFirm);
    fixture.componentRef.setInput('id', '7');
    TestBed.tick();
    http.expectOne((req) => req.url.endsWith('/v1/admin/firms/7')).flush(FIRM);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const settle = async () => {
      await tick();
      await fixture.whenStable();
    };
    return { el, settle };
  };

  const mergeWith = async (el: HTMLElement, settle: () => Promise<void>, id: string) => {
    const input = el.querySelector<HTMLInputElement>('input[name=mergeId]') as HTMLInputElement;
    input.value = id;
    input.dispatchEvent(new Event('input'));
    await settle();
    input.closest('form')?.dispatchEvent(new Event('submit'));
    await settle();
  };

  it('merges only after the staff member confirms', async () => {
    const { el, settle } = await render();
    confirm.mockReturnValue(false);
    await mergeWith(el, settle, '9');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Merge firm #7 and firm #9?'));
    http.expectNone((req) => req.url.endsWith('/v1/admin/firms/merge'));

    confirm.mockReturnValue(true);
    await mergeWith(el, settle, '9');
    const merge = http.expectOne((req) => req.url.endsWith('/v1/admin/firms/merge'));
    expect(merge.request.body).toEqual({ firmIds: [7, 9] });
    merge.flush({ keptId: 7, otherId: 9, moved: {} });
    await tick();
    // The kept firm is the one on screen, so it reloads with what it took.
    http.expectOne((req) => req.url.endsWith('/v1/admin/firms/7')).flush(FIRM);
    await settle();
    expect(el.textContent).toContain('Merged firm #9 into firm #7.');
  });

  it('splits the ticked records only after the staff member confirms', async () => {
    const { el, settle } = await render();
    el.querySelector<HTMLInputElement>('table mat-checkbox input')?.click();
    await settle();
    const move = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Move 1 selected')) as HTMLButtonElement;

    confirm.mockReturnValue(false);
    move.click();
    await settle();
    expect(confirm).toHaveBeenCalledWith('Move 1 record of firm #7 to a new firm?');
    http.expectNone((req) => req.url.includes('/split'));

    confirm.mockReturnValue(true);
    move.click();
    await settle();
    const split = http.expectOne((req) => req.url.endsWith('/v1/admin/firms/7/split'));
    expect(split.request.body).toEqual({ records: [{ source: 'import_alert', key: 'l-1' }] });
    split.flush({ keptId: 7, otherId: 12, moved: { import_alert_listing: 1 } });
    await tick();
    http.expectOne((req) => req.url.endsWith('/v1/admin/firms/7')).flush(FIRM);
    await settle();
    expect(el.textContent).toContain('Moved 1 record to a new firm.');
  });
});
