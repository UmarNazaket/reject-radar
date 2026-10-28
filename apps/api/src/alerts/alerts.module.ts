import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { NotificationPrefsController } from './notification-prefs.controller';

/** Imported by the watchlists module, which asks it for unread counts; this module never imports the watchlists. */
@Module({
  controllers: [AlertsController, NotificationPrefsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
