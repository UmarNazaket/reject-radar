import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import {
  type ApiEnv,
  type EmailOnlyRequest,
  emailOnlyRequest,
  type LoginRequest,
  loginRequest,
  type MeResponse,
  type SignupRequest,
  signupRequest,
  type StatusResponse,
  type TokenRequest,
  tokenRequest,
} from '@rejectradar/contracts';
import type { Request, Response } from 'express';
import { AppError } from '../common/errors';
import { RateLimit } from '../common/rate-limit';
import { ZodValidationPipe } from '../common/zod-pipe';
import { API_ENV } from '../config/env';
import { clearSessionCookies, REFRESH_COOKIE, setSessionCookies } from './cookies';
import { SessionsService } from './sessions.service';
import { SignupService } from './signup.service';

const HOUR_MS = 3_600_000;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly signups: SignupService,
    private readonly sessions: SessionsService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  @Post('signup')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit({ name: 'signup', limit: 5, windowMs: HOUR_MS, key: 'ip' })
  signup(@Body(new ZodValidationPipe(signupRequest)) body: SignupRequest): Promise<StatusResponse> {
    return this.signups.signup(body);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  verifyEmail(@Body(new ZodValidationPipe(tokenRequest)) body: TokenRequest): Promise<StatusResponse> {
    return this.signups.verifyEmail(body.token);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(
    { name: 'resend-email', limit: 3, windowMs: HOUR_MS, key: 'email' },
    { name: 'resend-ip', limit: 10, windowMs: HOUR_MS, key: 'ip' },
  )
  resendVerification(@Body(new ZodValidationPipe(emailOnlyRequest)) body: EmailOnlyRequest): Promise<StatusResponse> {
    return this.signups.resendVerification(body.email);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'login', limit: 10, windowMs: 900_000, key: 'ip+email' })
  async login(
    @Body(new ZodValidationPipe(loginRequest)) body: LoginRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const { me, access, refresh } = await this.sessions.login(body.email, body.password);
    setSessionCookies(res, this.env, access, refresh);
    return me;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.NO_CONTENT)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    try {
      const { access, refresh } = await this.sessions.refresh(this.refreshCookie(req) ?? '');
      setSessionCookies(res, this.env, access, refresh);
    } catch (error) {
      // Only a dead session clears the cookies. A refresh race must keep them: the other tab has just set new ones.
      if (error instanceof AppError && error.code === 'INVALID_SESSION') clearSessionCookies(res, this.env);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.sessions.logout(this.refreshCookie(req));
    clearSessionCookies(res, this.env);
  }

  private refreshCookie(req: Request): string | undefined {
    const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    return typeof value === 'string' && value !== '' ? value : undefined;
  }
}
