import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { MeController } from './me.controller';
import { MembersService } from './members.service';
import { OrgController } from './org.controller';

@Module({
  imports: [AuthModule],
  controllers: [MeController, OrgController, InvitesController],
  providers: [MembersService, InvitesService],
})
export class OrgsModule {}
