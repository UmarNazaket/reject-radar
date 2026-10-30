import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Router } from '@angular/router';
import {
  type AdminTaxonomyRule,
  RULE_MATCH_TYPES,
  RULE_SOURCES,
  type RuleMatchType,
  type RuleSource,
  TAXONOMY_RULE_KINDS,
  type TaxonomyClassification,
  type TaxonomyPreviewResponse,
  type TaxonomyRemapStatus,
  type TaxonomyResponse,
  type TaxonomyRuleKind,
  type TaxonomyRulesResponse,
} from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { adminError, adminTime } from './admin-format';

interface Draft {
  kind: TaxonomyRuleKind;
  /** The rule being changed; none for a new rule. */
  id?: number;
  source: RuleSource;
  field: string;
  matchType: RuleMatchType;
  pattern: string;
  targetId: number | null;
  priority: number;
  /** The sample text the preview classifies, as the rule's field. */
  sample: string;
  /** The source the preview classifies as, for a rule of every source (`*`). */
  previewSource: Exclude<RuleSource, '*'>;
}

const PREVIEW_SOURCES = RULE_SOURCES.filter((s): s is Exclude<RuleSource, '*'> => s !== '*');

/** The commodity and hazard rules: filter, try a rule on a sample, add, change or delete it, and ask for a remap. */
@Component({
  selector: 'app-admin-taxonomy-rules',
  imports: [FormsModule, MatButtonModule, Alert],
  template: `
    <section class="rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <h2 class="font-medium">Remap</h2>
      @if (remap.hasValue()) {
        @let r = remap.value();
        <p class="mt-1 text-slate-700">
          Last remap: {{ r.lastRun ? time(r.lastRun.at) + ', ' + changed(r.lastRun.updated) + ' records changed' : 'never' }}.
          @if (r.waiting && r.requested) {
            Requested {{ time(r.requested.at) }}{{ r.requested.by ? ' by ' + r.requested.by : '' }}; the next daily sync runs it.
          }
        </p>
      }
      <button matButton="outlined" type="button" class="mt-2" [disabled]="action.busy() || (remap.hasValue() && remap.value().waiting)" (click)="requestRemap()">
        Request a remap
      </button>
    </section>

    <div class="mt-4 flex flex-wrap items-end gap-x-4 gap-y-2 text-sm">
      <label
        >Kind
        <select #kindSel class="admin-control" [value]="shownKind()" (change)="navigate({ kind: kindSel.value, field: null, target: null })">
          @for (k of kinds; track k) {
            <option [value]="k">{{ k === 'commodity' ? 'Commodity' : 'Hazard' }}</option>
          }
        </select>
      </label>
      <label
        >Source
        <select #sourceSel class="admin-control" [value]="source() ?? ''" (change)="navigate({ source: sourceSel.value || null, field: null })">
          <option value="">Any</option>
          @for (s of sources; track s) {
            <option [value]="s">{{ s }}</option>
          }
        </select>
      </label>
      <label
        >Field
        <select #fieldSel class="admin-control" [value]="field() ?? ''" (change)="navigate({ field: fieldSel.value || null })">
          <option value="">Any</option>
          @for (f of fieldNames(); track f) {
            <option [value]="f">{{ f }}</option>
          }
        </select>
      </label>
      <label
        >Target
        <select #targetSel class="admin-control max-w-56" [value]="target() ?? ''" (change)="navigate({ target: targetSel.value || null })">
          <option value="">Any</option>
          @for (t of targets(); track t.id) {
            <option [value]="'' + t.id">{{ t.label }}</option>
          }
        </select>
      </label>
      <form (ngSubmit)="navigate({ q: search().trim() || null })">
        <label>Pattern contains<input name="q" class="admin-control" [(ngModel)]="search" /></label>
      </form>
      <button matButton="filled" type="button" (click)="startNew()">Add a rule</button>
    </div>

    @if (action.error(); as error) {
      <app-alert class="mt-4 block">{{ error }}</app-alert>
    }
    @if (done(); as text) {
      <app-alert kind="success" class="mt-4 block">{{ text }}</app-alert>
    }

    @if (draft(); as d) {
      <form #ruleForm="ngForm" class="mt-4 rounded-lg border border-sky-200 bg-white p-4 text-sm" (ngSubmit)="ruleForm.valid && save(d)">
        <h2 class="font-medium">{{ d.id ? 'Change ' + d.kind + ' rule #' + d.id : 'New ' + d.kind + ' rule' }}</h2>
        <div class="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2">
          <label
            >Source
            <select name="source" required class="admin-control" [(ngModel)]="d.source">
              @for (s of sources; track s) {
                <option [ngValue]="s">{{ s }}</option>
              }
            </select>
          </label>
          <label>Field<input name="field" required pattern="[a-z][a-z_]*" maxlength="50" list="rule-fields" class="admin-control" [(ngModel)]="d.field" /></label>
          <datalist id="rule-fields">
            @for (f of fieldNames(); track f) {
              <option [value]="f"></option>
            }
          </datalist>
          <label
            >Match
            <select name="matchType" required class="admin-control" [(ngModel)]="d.matchType">
              @for (m of matchTypes; track m) {
                <option [ngValue]="m">{{ m }}</option>
              }
            </select>
          </label>
          <label>Pattern<input name="pattern" required maxlength="200" class="admin-control" [(ngModel)]="d.pattern" /></label>
          <label
            >{{ d.kind === 'commodity' ? 'Commodity' : 'Hazard' }}
            <select name="targetId" required class="admin-control max-w-56" [(ngModel)]="d.targetId">
              @for (t of targetsOf(d.kind); track t.id) {
                <option [ngValue]="t.id">{{ t.label }}</option>
              }
            </select>
          </label>
          <label>Priority<input name="priority" type="number" required min="0" max="32767" class="admin-control w-24" [(ngModel)]="d.priority" /></label>
        </div>
        <p class="mt-1 text-slate-600">The first matching rule wins: lower priority numbers go first. Keyword and exact patterns are saved normalised.</p>

        <h3 class="mt-4 font-medium">Try it first</h3>
        <div class="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2">
          @if (d.source === '*') {
            <label
              >As a record of
              <select name="previewSource" class="admin-control" [(ngModel)]="d.previewSource">
                @for (s of previewSources; track s) {
                  <option [ngValue]="s">{{ s }}</option>
                }
              </select>
            </label>
          }
          <label class="min-w-72 flex-1"
            >Sample text of {{ d.field || 'the field' }}<input name="sample" required maxlength="2000" class="admin-control w-full" [(ngModel)]="d.sample"
          /></label>
          <button matButton="outlined" type="button" [disabled]="action.busy() || !ruleForm.valid" (click)="preview(d)">Preview</button>
        </div>
        @if (shownPreview(); as p) {
          <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt class="text-slate-600">Stored rules</dt>
            <dd>{{ describe(p.current) }}</dd>
            @if (p.withRule; as w) {
              <dt class="text-slate-600">With this rule</dt>
              <dd class="font-medium">{{ describe(w) }}</dd>
            }
          </dl>
        }
        <div class="mt-4 flex gap-2">
          <button matButton="filled" type="submit" [disabled]="action.busy() || !shownPreview()">Save rule</button>
          <button matButton type="button" (click)="draft.set(null)">Cancel</button>
        </div>
        @if (!shownPreview()) {
          <p class="mt-1 text-slate-600">Preview the rule as it stands to save it.</p>
        }
      </form>
    }

    @if (rules.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (rules.hasValue()) {
      @let list = rules.value();
      <div class="mt-4 overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-slate-600">
            <tr class="border-b border-slate-200">
              <th scope="col" class="py-2 pe-4 text-start font-medium">Source</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Field</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Match</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Pattern</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Target</th>
              <th scope="col" class="py-2 pe-4 text-end font-medium">Priority</th>
              <th scope="col" class="py-2 text-start font-medium"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            @for (rule of list.items; track rule.id) {
              <tr class="border-b border-slate-100 align-top">
                <td class="py-2 pe-4">{{ rule.source }}</td>
                <td class="py-2 pe-4">{{ rule.field }}</td>
                <td class="py-2 pe-4">{{ rule.matchType }}</td>
                <td class="py-2 pe-4 break-all">{{ rule.pattern }}</td>
                <td class="py-2 pe-4">{{ label(rule.kind, rule.targetId) }}</td>
                <td class="py-2 pe-4 text-end">{{ rule.priority }}</td>
                <td class="py-1 whitespace-nowrap">
                  <button matButton type="button" [attr.aria-label]="'Change rule ' + rule.id" (click)="startEdit(rule)">Change</button>
                  <button matButton type="button" [attr.aria-label]="'Delete rule ' + rule.id" [disabled]="action.busy()" (click)="remove(rule)">Delete</button>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="7" class="py-4 text-slate-600">No rules match.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (list.more) {
        <p class="mt-2 text-sm text-slate-600">Showing the first {{ list.items.length }} rules in evaluation order. Narrow the filters to see the rest.</p>
      }
    } @else {
      <p class="mt-4 text-slate-600">Loading…</p>
    }
  `,
})
export class AdminTaxonomyRules {
  private readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly kinds = TAXONOMY_RULE_KINDS;
  protected readonly sources = RULE_SOURCES;
  protected readonly previewSources = PREVIEW_SOURCES;
  protected readonly matchTypes = RULE_MATCH_TYPES;
  protected readonly time = adminTime;

  /** The filters, from the query string. */
  readonly kind = input<string>();
  readonly source = input<string>();
  readonly field = input<string>();
  readonly target = input<string>();
  readonly q = input<string>();
  protected readonly shownKind = computed<TaxonomyRuleKind>(() => TAXONOMY_RULE_KINDS.find((k) => k === this.kind()) ?? 'commodity');
  protected readonly search = linkedSignal(() => this.q() ?? '');

  protected readonly rules = httpResource<TaxonomyRulesResponse>(() => {
    const params: Record<string, string> = { kind: this.shownKind() };
    for (const [key, value] of [['source', this.source()], ['field', this.field()], ['target', this.target()], ['q', this.q()]] as const) {
      if (value) params[key] = value;
    }
    return { url: apiUrl('/v1/admin/taxonomy-rules'), params };
  });
  protected readonly remap = httpResource<TaxonomyRemapStatus>(() => apiUrl('/v1/admin/taxonomy/remap'));
  // The admin area is in English, whatever language the app is shown in.
  private readonly taxonomy = httpResource<TaxonomyResponse>(() => ({ url: apiUrl('/v1/taxonomy'), params: { locale: 'en' } }));

  protected readonly fieldNames = computed(() => {
    const fields = this.rules.hasValue() ? this.rules.value().fields : [];
    const source = this.source();
    return [...new Set(fields.filter((f) => !source || f.source === source).map((f) => f.field))].sort();
  });
  protected readonly targets = computed(() => this.targetsOf(this.shownKind()));

  protected readonly action = new FormState(this.i18n, adminError);
  protected readonly done = signal<string | null>(null);
  protected readonly draft = signal<Draft | null>(null);
  /** The last preview, with the draft it was made for. */
  private readonly lastPreview = signal<{ key: string; result: TaxonomyPreviewResponse } | null>(null);

  // A method, not a computed: ngModel writes into the draft object without setting the signal.
  protected shownPreview(): TaxonomyPreviewResponse | null {
    const draft = this.draft();
    const last = this.lastPreview();
    return draft && last && last.key === JSON.stringify(draft) ? last.result : null;
  }

  protected targetsOf(kind: TaxonomyRuleKind): { id: number; label: string }[] {
    const value = this.taxonomy.hasValue() ? this.taxonomy.value() : null;
    return (kind === 'commodity' ? value?.commodities : value?.hazards) ?? [];
  }

  protected label(kind: TaxonomyRuleKind, id: number): string {
    return this.targetsOf(kind).find((t) => t.id === id)?.label ?? `#${id}`;
  }

  protected describe(result: TaxonomyClassification): string {
    return `${this.label('commodity', result.commodityId)}; hazards: ${result.hazardIds.map((id) => this.label('hazard', id)).join(', ')}`;
  }

  protected changed(updated: Record<string, number>): number {
    return Object.values(updated).reduce((sum, n) => sum + n, 0);
  }

  protected errorText(error: unknown): string {
    return adminError(this.i18n, error);
  }

  protected navigate(params: Record<string, string | null>): void {
    void this.router.navigate([], { queryParams: params, queryParamsHandling: 'merge' });
  }

  protected startNew(): void {
    const source = (this.source() as RuleSource | undefined) ?? 'rasff';
    this.draft.set({
      kind: this.shownKind(),
      source,
      field: this.field() ?? '',
      matchType: 'keyword',
      pattern: '',
      targetId: null,
      priority: 10,
      sample: '',
      previewSource: source === '*' ? 'rasff' : source,
    });
  }

  protected startEdit(rule: AdminTaxonomyRule): void {
    const { id, kind, source, field, matchType, pattern, targetId, priority } = rule;
    this.draft.set({ id, kind, source, field, matchType, pattern, targetId, priority, sample: '', previewSource: source === '*' ? 'rasff' : source });
  }

  protected preview(draft: Draft): void {
    const key = JSON.stringify(draft);
    void this.action.run(async () => {
      const result = await firstValueFrom(
        this.http.post<TaxonomyPreviewResponse>(apiUrl('/v1/admin/taxonomy-rules/preview'), {
          source: draft.source === '*' ? draft.previewSource : draft.source,
          fields: { [draft.field]: draft.sample },
          rule: { ...this.ruleBody(draft), kind: draft.kind, id: draft.id },
        }),
      );
      this.lastPreview.set({ key, result });
    });
  }

  protected save(draft: Draft): void {
    if (!this.shownPreview()) return;
    this.done.set(null);
    void this.action.run(async () => {
      const saved = draft.id
        ? await firstValueFrom(this.http.patch<AdminTaxonomyRule>(apiUrl(`/v1/admin/taxonomy-rules/${draft.kind}/${draft.id}`), this.ruleBody(draft)))
        : await firstValueFrom(this.http.post<AdminTaxonomyRule>(apiUrl('/v1/admin/taxonomy-rules'), { ...this.ruleBody(draft), kind: draft.kind }));
      this.draft.set(null);
      this.done.set(`Saved ${saved.kind} rule #${saved.id}. Stored records change with the next remap.`);
      this.rules.reload();
    });
  }

  protected remove(rule: AdminTaxonomyRule): void {
    if (!confirm(`Delete ${rule.kind} rule #${rule.id} (${rule.field} ${rule.matchType} "${rule.pattern}")? Stored records change with the next remap.`)) return;
    this.done.set(null);
    void this.action.run(async () => {
      await firstValueFrom(this.http.delete(apiUrl(`/v1/admin/taxonomy-rules/${rule.kind}/${rule.id}`)));
      if (this.draft()?.id === rule.id) this.draft.set(null);
      this.done.set(`Deleted ${rule.kind} rule #${rule.id}.`);
      this.rules.reload();
    });
  }

  protected requestRemap(): void {
    if (!confirm('Re-apply every rule to every stored record? The daily sync job runs it after its syncs; records and notices change, and no alerts are sent.')) return;
    this.done.set(null);
    void this.action.run(async () => {
      await firstValueFrom(this.http.post(apiUrl('/v1/admin/taxonomy/remap'), {}));
      this.remap.reload();
    });
  }

  private ruleBody(draft: Draft) {
    const { source, field, matchType, pattern, targetId, priority } = draft;
    return { source, field, matchType, pattern, targetId, priority: Number(priority) };
  }
}
