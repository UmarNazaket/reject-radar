import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessTokenService } from './access-tokens';
import { AuthController } from './auth.controller';
import { EmailTokensService } from './email-tokens.service';
import { PasswordResetService } from './password-reset.service';
import { SessionsService } from './sessions.service';
import { SignupService } from './signup.service';

@Module({
  // The secret and algorithm are passed per call by AccessTokenService, so the module itself has no options.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [SignupService, PasswordResetService, EmailTokensService, SessionsService, AccessTokenService],
  exports: [EmailTokensService, SessionsService, AccessTokenService],
})
export class AuthModule {}
