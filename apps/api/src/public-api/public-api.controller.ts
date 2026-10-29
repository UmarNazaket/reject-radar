import { Controller, Get, Param, Query, UseInterceptors } from '@nestjs/common';
import {
  type DashboardQuery,
  type DashboardResponse,
  dashboardQuery,
  type FirmProfileResponse,
  type FirmSearchQuery,
  type FirmSearchResponse,
  firmSearchQuery,
  type ImportAlertQuery,
  type ImportAlertResponse,
  importAlertNumberSchema,
  importAlertQuery,
  type NoticeItem,
  type NoticeSearchQuery,
  type NoticeSearchResponse,
  noticeSearchQuery,
  type PublicUsageResponse,
  type TaxonomyQuery,
  type TaxonomyResponse,
  taxonomyQuery,
} from '@rejectradar/contracts';
import type { ApiKeyContext } from '../auth/context';
import { ApiKeyAuth, CurrentApiKey } from '../auth/decorators';
import { PositiveIntParamPipe } from '../common/int-param.pipe';
import { RateLimit } from '../common/rate-limit';
import { ZodValidationPipe } from '../common/zod-pipe';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { FirmProfileService } from '../firms/firm-profile.service';
import { FirmSearchService } from '../firms/firm-search.service';
import { ImportAlertsService } from '../import-alerts/import-alerts.service';
import { DashboardsService } from '../notices/dashboards.service';
import { NoticesService } from '../notices/notices.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { ApiQuotaInterceptor } from './api-quota.interceptor';

/** Every public route shares one window per key. */
const PUBLIC_RATE_LIMIT = { name: 'public-api', limit: 60, windowMs: 60_000, key: 'apiKey' } as const;

/**
 * The public API (spec §9): the app's own read routes and contracts, for Business and Enterprise accounts, signed in by
 * an API key. Each call is charged one `api_calls` unit. Declare static routes (`firms/search`) before `:id` routes.
 */
@Controller('public')
@ApiKeyAuth()
@RateLimit(PUBLIC_RATE_LIMIT)
@UseInterceptors(ApiQuotaInterceptor)
export class PublicApiController {
  constructor(
    private readonly notices: NoticesService,
    private readonly dashboards: DashboardsService,
    private readonly firmSearch: FirmSearchService,
    private readonly firmProfiles: FirmProfileService,
    private readonly importAlerts: ImportAlertsService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  @Get('notices')
  searchNotices(@CurrentApiKey() key: ApiKeyContext, @Query(new ZodValidationPipe(noticeSearchQuery)) query: NoticeSearchQuery): Promise<NoticeSearchResponse> {
    return this.notices.search(key.orgId, query);
  }

  @Get('notices/:id')
  notice(@CurrentApiKey() key: ApiKeyContext, @Param('id', new PositiveIntParamPipe()) id: number): Promise<NoticeItem> {
    return this.notices.get(key.orgId, id);
  }

  @Get('dashboards/topic')
  topic(@CurrentApiKey() key: ApiKeyContext, @Query(new ZodValidationPipe(dashboardQuery)) query: DashboardQuery): Promise<DashboardResponse> {
    return this.dashboards.topic(key.orgId, query);
  }

  @Get('firms/search')
  searchFirms(@Query(new ZodValidationPipe(firmSearchQuery)) query: FirmSearchQuery): Promise<FirmSearchResponse> {
    return this.firmSearch.search(query);
  }

  /** Uses one firm lookup as in the app, besides the API call. */
  @Get('firms/:id')
  firm(@CurrentApiKey() key: ApiKeyContext, @Param('id', new PositiveIntParamPipe()) id: number): Promise<FirmProfileResponse> {
    return this.firmProfiles.profile({ orgId: key.orgId }, id);
  }

  @Get('import-alerts/:number')
  importAlert(
    @Param('number', new ZodValidationPipe(importAlertNumberSchema)) number: string,
    @Query(new ZodValidationPipe(importAlertQuery)) query: ImportAlertQuery,
  ): Promise<ImportAlertResponse> {
    return this.importAlerts.get(number, query.locale);
  }

  @Get('taxonomy')
  labels(@Query(new ZodValidationPipe(taxonomyQuery)) query: TaxonomyQuery): Promise<TaxonomyResponse> {
    return this.taxonomy.labels(query.locale);
  }
}

/** This month's API calls; reading it is not charged. */
@Controller('public/usage')
@ApiKeyAuth()
@RateLimit(PUBLIC_RATE_LIMIT)
export class PublicUsageController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @Get()
  async usage(@CurrentApiKey() key: ApiKeyContext): Promise<PublicUsageResponse> {
    const [{ period, apiCalls }, { limits }] = await Promise.all([this.entitlements.usage(key.orgId), this.entitlements.resolvePlan(key.orgId)]);
    return { period, apiCalls: { used: apiCalls, limit: limits.apiCallsPerMonth } };
  }
}
