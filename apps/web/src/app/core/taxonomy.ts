import { httpResource } from '@angular/common/http';
import { computed, inject, Injectable } from '@angular/core';
import type { TaxonomyResponse } from '@rejectradar/contracts';
import { apiUrl } from './api';
import { I18n } from './i18n';

/** Commodities, hazards, destinations and countries with labels in the current language, loaded again when it changes. */
@Injectable({ providedIn: 'root' })
export class Taxonomy {
  private readonly i18n = inject(I18n);
  readonly data = httpResource<TaxonomyResponse>(() => ({ url: apiUrl('/v1/taxonomy'), params: { locale: this.i18n.locale() } }));
  private readonly value = computed(() => (this.data.hasValue() ? this.data.value() : null));

  readonly countries = computed(() => this.value()?.countries ?? []);
  readonly destinations = computed(() => this.value()?.destinations ?? []);
  readonly hazardCategories = computed(() => this.value()?.hazardCategories ?? []);
  /** Commodities in tree order, each with its depth, so a list can indent the children under their parent. */
  readonly commodityTree = computed(() => {
    const commodities = this.value()?.commodities ?? [];
    const tree = (parentId: number | null, depth: number): { id: number; label: string; depth: number }[] =>
      commodities.filter((c) => c.parentId === parentId).flatMap((c) => [{ id: c.id, label: c.label, depth }, ...tree(c.id, depth + 1)]);
    return tree(null, 0);
  });

  /** Every label by kind and id; ids are kept as strings so numeric and text ids share one lookup. */
  private readonly labels = computed(() => {
    const value = this.value();
    const byId = (entries: { id: string | number; label: string }[] = []) => new Map(entries.map((e) => [String(e.id), e.label]));
    return {
      commodity: byId(value?.commodities),
      hazard: byId(value?.hazards),
      hazardCategory: byId(value?.hazardCategories),
      destination: byId(value?.destinations),
      country: byId(value?.countries.map((c) => ({ id: c.code, label: c.label }))),
    };
  });

  /** The label of a taxonomy entry, or its id while the labels load. */
  label(kind: 'commodity' | 'hazard' | 'hazardCategory' | 'destination' | 'country', id: string | number): string {
    return this.labels()[kind].get(String(id)) ?? String(id);
  }
}
