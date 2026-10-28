import { Body, Controller, Get, Put } from '@nestjs/common';
import { type NotificationPrefs, notificationPrefsSchema } from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-pipe';
import { AlertsService } from './alerts.service';

/** The caller's own email settings: per user, not per account, so a user only ever reads and writes their own row. */
@Controller('me/notification-prefs')
export class NotificationPrefsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  get(@CurrentContext() ctx: RequestContext): Promise<NotificationPrefs> {
    return this.alerts.getPrefs(ctx);
  }

  @Put()
  put(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(notificationPrefsSchema)) body: NotificationPrefs): Promise<NotificationPrefs> {
    return this.alerts.savePrefs(ctx, body);
  }
}
