import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { I18n } from '../core/i18n';
import { Alert } from './alert';

describe('Alert', () => {
  beforeEach(async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ 'web.seePlans': 'See plans' }) }) as Response) as unknown as typeof fetch;
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    await TestBed.inject(I18n).use('en');
  });

  const render = async (upgrade: boolean) => {
    const fixture = TestBed.createComponent(Alert);
    fixture.componentRef.setInput('upgrade', upgrade);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  };

  it('links to the plans only for a plan error', async () => {
    expect((await render(true)).querySelector('a[href="/settings/billing"]')?.textContent).toContain('See plans');
    expect((await render(false)).querySelector('a')).toBeNull();
  });
});
