import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { I18n } from '../core/i18n';
import { Session } from '../core/session';
import { Login } from './login';

const EN = { 'web.login.title': 'Sign in to RejectRadar', 'errors.INVALID_CREDENTIALS': 'The email or password is incorrect.' };

describe('Login', () => {
  let session: { login: jest.Mock };

  beforeEach(async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => EN }) as Response) as unknown as typeof fetch;
    session = { login: jest.fn().mockResolvedValue(undefined) };
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Session, useValue: session }] });
    await TestBed.inject(I18n).use('en');
  });

  const render = async (next?: string) => {
    const fixture = TestBed.createComponent(Login);
    if (next !== undefined) fixture.componentRef.setInput('next', next);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const type = (name: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(`input[name=${name}]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    const submit = async () => {
      el.querySelector('form')?.dispatchEvent(new Event('submit'));
      await fixture.whenStable();
    };
    return { el, type, submit };
  };

  it('signs in and goes where the user was headed', async () => {
    const navigate = jest.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { el, type, submit } = await render('/firms/12');
    expect(el.querySelector('h1')?.textContent).toContain('Sign in to RejectRadar');
    type('email', 'ayesha@example.com');
    type('password', 'zarfeen-rice-2026');
    await submit();
    expect(session.login).toHaveBeenCalledWith({ email: 'ayesha@example.com', password: 'zarfeen-rice-2026' });
    expect(navigate).toHaveBeenCalledWith('/firms/12');
  });

  it('does not send a form with missing fields', async () => {
    const { submit } = await render();
    await submit();
    expect(session.login).not.toHaveBeenCalled();
  });

  it('shows the API error in the user language', async () => {
    session.login.mockRejectedValue(new HttpErrorResponse({ status: 401, error: { code: 'INVALID_CREDENTIALS', message: 'x', requestId: 'r' } }));
    const { el, type, submit } = await render();
    type('email', 'ayesha@example.com');
    type('password', 'wrong-password');
    await submit();
    expect(el.textContent).toContain('The email or password is incorrect.');
  });
});
