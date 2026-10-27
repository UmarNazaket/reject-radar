import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  type EmailOnlyRequest,
  emailOnlyRequest,
  type SignupRequest,
  signupRequest,
  type StatusResponse,
  type TokenRequest,
  tokenRequest,
} from '@rejectradar/contracts';
import { RateLimit } from '../common/rate-limit';
import { ZodValidationPipe } from '../common/zod-pipe';
import { SignupService } from './signup.service';

const HOUR_MS = 3_600_000;

@Controller('auth')
export class AuthController {
  constructor(private readonly signups: SignupService) {}

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
}
