import { Inject, Injectable } from '@nestjs/common';
import {
  DESTINATIONS,
  HAZARD_CATEGORIES,
  type HazardCategoryId,
  type Locale,
  type TaxonomyResponse,
} from '@rejectradar/contracts';
import { commodity, type Database, hazard } from '@rejectradar/db';
import { CATALOGS } from '@rejectradar/i18n';
import { DB } from '../database/database.module';
import { NoticesService } from '../notices/notices.service';

/** Countries come from the notices, which grow every day, so they are re-read once an hour. */
export const COUNTRIES_TTL_MS = 60 * 60 * 1000;

interface CommodityRow {
  id: number;
  slug: string;
  parentId: number | null;
  name: string;
}

interface HazardRow {
  id: number;
  slug: string;
  category: HazardCategoryId;
  name: string;
}

interface Reference {
  commodities: CommodityRow[];
  hazards: HazardRow[];
}

interface CountryCache {
  readAt: number;
  codes: string[];
}

/**
 * Public reference data (P5-D4). Commodities and hazards change only through migrations, so they are read once and
 * kept; labels come from the catalogs, and country names from ICU.
 */
@Injectable()
export class TaxonomyService {
  private reference: Promise<Reference> | null = null;
  private countries: CountryCache | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly notices: NoticesService,
  ) {}

  async labels(locale: Locale): Promise<TaxonomyResponse> {
    const [{ commodities, hazards }, codes] = await Promise.all([this.loadReference(), this.loadCountryCodes()]);
    const label = (key: string, fallback: string): string => CATALOGS[locale][key] ?? CATALOGS.en[key] ?? fallback;
    return {
      commodities: commodities.map((c) => ({
        id: c.id,
        slug: c.slug,
        parentId: c.parentId,
        label: label(`taxonomy.commodity.${c.slug}`, c.name),
      })),
      hazards: hazards.map((h) => ({
        id: h.id,
        slug: h.slug,
        category: h.category,
        label: label(`taxonomy.hazard.${h.slug}`, h.name),
      })),
      hazardCategories: HAZARD_CATEGORIES.map((id) => ({ id, label: label(`taxonomy.hazardCategory.${id}`, id) })),
      destinations: DESTINATIONS.map((id) => ({ id, label: label(`taxonomy.destination.${id}`, id) })),
      countries: this.countryLabels(codes, locale),
    };
  }

  async commodityExists(id: number): Promise<boolean> {
    return (await this.loadReference()).commodities.some((c) => c.id === id);
  }

  async hazardExists(id: number): Promise<boolean> {
    return (await this.loadReference()).hazards.some((h) => h.id === id);
  }

  private loadReference(): Promise<Reference> {
    this.reference ??= this.readReference().catch((error: unknown) => {
      this.reference = null; // a failed read must not be remembered
      throw error;
    });
    return this.reference;
  }

  private async readReference(): Promise<Reference> {
    const [commodities, hazards] = await Promise.all([
      this.db
        .select({ id: commodity.id, slug: commodity.slug, parentId: commodity.parentId, name: commodity.name })
        .from(commodity)
        .orderBy(commodity.id),
      this.db
        .select({ id: hazard.id, slug: hazard.slug, category: hazard.category, name: hazard.name })
        .from(hazard)
        .orderBy(hazard.id),
    ]);
    return { commodities, hazards: hazards as HazardRow[] };
  }

  private async loadCountryCodes(): Promise<string[]> {
    const now = Date.now();
    if (this.countries && now - this.countries.readAt < COUNTRIES_TTL_MS) return this.countries.codes;
    const codes = (await this.notices.originCountries()).filter((code) => /^[A-Z]{2}$/.test(code));
    this.countries = { readAt: now, codes };
    return codes;
  }

  /** Country names from ICU, sorted by name in the locale's own collation. */
  private countryLabels(codes: string[], locale: Locale): { code: string; label: string }[] {
    const names = new Intl.DisplayNames([locale], { type: 'region' });
    const collator = new Intl.Collator(locale);
    return codes
      .map((code) => ({ code, label: displayName(names, code) }))
      .sort((a, b) => collator.compare(a.label, b.label) || a.code.localeCompare(b.code));
  }
}

function displayName(names: Intl.DisplayNames, code: string): string {
  try {
    return names.of(code) ?? code;
  } catch {
    return code; // not a region ICU knows
  }
}
