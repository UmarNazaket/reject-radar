import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { EmailTokensService } from './email-tokens.service';
import { SignupService } from './signup.service';

@Module({
  controllers: [AuthController],
  providers: [SignupService, EmailTokensService],
  exports: [EmailTokensService],
})
export class AuthModule {}
