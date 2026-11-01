import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type AdminTaxonomyRule,
  type CreateTaxonomyRuleRequest,
  createTaxonomyRuleRequest,
  TAXONOMY_RULE_KINDS,
  type TaxonomyPreviewRequest,
  taxonomyPreviewRequest,
  type TaxonomyPreviewResponse,
  type TaxonomyRemapStatus,
  type TaxonomyRuleKind,
  type TaxonomyRuleQuery,
  taxonomyRuleQuery,
  type TaxonomyRuleRequest,
  taxonomyRuleRequest,
  type TaxonomyRulesResponse,
  type UnmappedQuery,
  unmappedQuery,
  type UnmappedResponse,
} from '@rejectradar/contracts';
import { z } from 'zod';
import type { RequestContext } from '../auth/context';
import { CurrentContext, PlatformAdmin, RequireVerifiedEmail } from '../auth/decorators';
import { PositiveIntParamPipe } from '../common/int-param.pipe';
import { ZodValidationPipe } from '../common/zod-pipe';
import { TaxonomyRulesService } from './taxonomy-rules.service';

const kindParam = z.enum(TAXONOMY_RULE_KINDS);

/** The commodity and hazard rules and the remap request, for RejectRadar staff (P10). */
@Controller('admin')
@PlatformAdmin()
@RequireVerifiedEmail()
export class TaxonomyRulesController {
  constructor(private readonly rules: TaxonomyRulesService) {}

  @Get('taxonomy-rules')
  list(@Query(new ZodValidationPipe(taxonomyRuleQuery)) query: TaxonomyRuleQuery): Promise<TaxonomyRulesResponse> {
    return this.rules.list(query);
  }

  @Post('taxonomy-rules')
  create(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createTaxonomyRuleRequest)) body: CreateTaxonomyRuleRequest): Promise<AdminTaxonomyRule> {
    return this.rules.create(ctx, body);
  }

  @Post('taxonomy-rules/preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body(new ZodValidationPipe(taxonomyPreviewRequest)) body: TaxonomyPreviewRequest): Promise<TaxonomyPreviewResponse> {
    return this.rules.preview(body);
  }

  @Patch('taxonomy-rules/:kind/:id')
  update(
    @CurrentContext() ctx: RequestContext,
    @Param('kind', new ZodValidationPipe(kindParam)) kind: TaxonomyRuleKind,
    @Param('id', PositiveIntParamPipe) id: number,
    @Body(new ZodValidationPipe(taxonomyRuleRequest)) body: TaxonomyRuleRequest,
  ): Promise<AdminTaxonomyRule> {
    return this.rules.update(ctx, kind, id, body);
  }

  @Delete('taxonomy-rules/:kind/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentContext() ctx: RequestContext,
    @Param('kind', new ZodValidationPipe(kindParam)) kind: TaxonomyRuleKind,
    @Param('id', PositiveIntParamPipe) id: number,
  ): Promise<void> {
    return this.rules.remove(ctx, kind, id);
  }

  @Get('taxonomy/unmapped')
  unmapped(@Query(new ZodValidationPipe(unmappedQuery)) query: UnmappedQuery): Promise<UnmappedResponse> {
    return this.rules.unmapped(query);
  }

  @Get('taxonomy/remap')
  remapStatus(): Promise<TaxonomyRemapStatus> {
    return this.rules.remapStatus();
  }

  @Post('taxonomy/remap')
  @HttpCode(HttpStatus.OK)
  requestRemap(@CurrentContext() ctx: RequestContext): Promise<TaxonomyRemapStatus> {
    return this.rules.requestRemap(ctx);
  }
}
