import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { MeController } from './me.controller';
import { MembersService } from './members.service';
import { OrgController } from './org.controller';

@Module({
  imports: [AuthModule, EntitlementsModule],
  controllers: [MeController, OrgController, InvitesController],
  providers: [MembersService, InvitesService],
  exports: [MembersService, InvitesService],
})
export class OrgsModule {}
