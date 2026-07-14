// ============================================================
// CSV parsing, export formatting, and import classify/apply logic.
//
// Ported from the host CMS (src/utils/csv.ts) when import/export moved into
// this plugin. The difference: instead of reading/writing D1 directly, all
// data flows through the Plugin API — blueprint path specs, languages and
// taxonomies come from GET /__cms/content-meta, pages from GET /__cms/pages,
// and writes go through POST /__cms/pages/batch and PUT /__cms/pages/:id.
// The pure CSV/lect logic below is unchanged in behaviour.
// ============================================================

import type { BlueprintPathKind, CmsPage, ContentMeta, PageTag } from './cms';

export type Lect = Record<string, unknown>;
export type LectItem = Record<string, unknown>;

export interface CsvPathSpec {
  header: string;
  sourcePath: string;
  kind: BlueprintPathKind;
  language?: string;
}

export type CsvImportMode = 'new' | 'append' | 'new-append' | 'overwrite' | 'new-overwrite' | 'force-new';

export interface CsvImportModeOption {
  value: CsvImportMode;
  label: string;
  description: string;
  destructive: boolean;
}

export const CSV_IMPORT_MODE_OPTIONS: CsvImportModeOption[] = [
  {
    value: 'new-append',
    label: 'New + Add Missing Fields',
    description: 'Create new pages and fill empty fields or add tags on existing pages.',
    destructive: false,
  },
  {
    value: 'new',
    label: 'New Pages Only',
    description: 'Create only rows that do not match an existing draft page.',
    destructive: false,
  },
  {
    value: 'new-overwrite',
    label: 'New + Replace Existing Fields',
    description: 'Create new pages and replace matching fields on existing pages.',
    destructive: true,
  },
  {
    value: 'append',
    label: 'Existing Pages: Add Missing Fields',
    description: 'Only fill empty fields or add tags on existing pages.',
    destructive: false,
  },
  {
    value: 'overwrite',
    label: 'Existing Pages: Replace Fields',
    description: 'Only replace matching fields on existing pages.',
    destructive: true,
  },
  {
    value: 'force-new',
    label: 'Treat All Rows As New Pages',
    description: 'Create every CSV row as a new draft page, even when it matches an existing page.',
    destructive: false,
  },
];

export function csvImportMode(value: string): CsvImportMode {
  return CSV_IMPORT_MODE_OPTIONS.some((option) => option.value === value)
    ? value as CsvImportMode
    : 'new-append';
}

export function csvImportModeOptions(selected: CsvImportMode = 'new-append') {
  return CSV_IMPORT_MODE_OPTIONS.map((option) => ({
    ...option,
    checked: option.value === selected,
  }));
}

// ── CSV parsing & formatting ─────────────────────────────────────────────────

export function csvFormatValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();

  // Numeric-looking values are wrapped as ="…" so spreadsheets keep them as
  // text (preserving leading zeros / long digit strings). This also neutralizes
  // any leading +/-/( that a spreadsheet would otherwise read as a formula.
  if (/^[\d\s\-+()]+$/.test(text) && /\d/.test(text)) {
    return `="${text.replace(/"/g, '""')}"`;
  }

  // CSV-injection guard: a cell whose first character is one a spreadsheet
  // treats as a formula trigger (= + - @) is prefixed with an apostrophe so
  // Excel/Sheets render it as literal text instead of evaluating it. Cell
  // values can originate from untrusted input (e.g. plugin write-back from a
  // public RSVP form), so this must hold for every export.
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;

  const escaped = guarded.replace(/"/g, '""');
  if (/[",\r\n]/.test(guarded)) return `"${escaped}"`;
  return escaped;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(normalizeCsvCell(cell));
      cell = '';
    } else if (char === '\n') {
      row.push(normalizeCsvCell(cell));
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(normalizeCsvCell(cell));
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((value) => value.trim() !== ''));
}

function normalizeCsvCell(value: string): string {
  const trimmed = value.trim();
  const formulaMatch = trimmed.match(/^="(.*)"$/);
  return formulaMatch ? formulaMatch[1].replace(/""/g, '"') : trimmed;
}

export function csvRowsToObjects(rows: string[][]): Array<Record<string, string>> {
  const [headers = [], ...dataRows] = rows;
  return dataRows.map((row) => Object.fromEntries(headers.map((header, index) => [
    header.trim().replace(/^﻿/, ''),
    row[index] ?? '',
  ])));
}

function splitListValue(value: string): string[] {
  return value.split(';').map((entry) => entry.trim()).filter(Boolean);
}

function hasCsvColumn(row: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function csvCellHasValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export function csvRowHasValues(row: Record<string, string>): boolean {
  return Object.values(row).some(csvCellHasValue);
}

// ── Path specs ───────────────────────────────────────────────────────────────

/** Blueprint-declared columns for a page type, localized paths expanded per language. */
export function csvPathSpecs(meta: ContentMeta, pageTypes: string[], includeLegacyLocalized = false): CsvPathSpec[] {
  const seen = new Set<string>();
  const specs: CsvPathSpec[] = [];
  for (const pageType of pageTypes) {
    for (const spec of meta.path_specs[pageType] ?? []) {
      if (seen.has(spec.path)) continue;
      seen.add(spec.path);
      if (spec.kind !== 'localized') {
        specs.push({ header: spec.path, sourcePath: spec.path, kind: spec.kind });
        continue;
      }
      if (includeLegacyLocalized) {
        specs.push({ header: spec.path, sourcePath: spec.path, kind: spec.kind, language: meta.default_language });
      }
      for (const language of meta.languages) {
        specs.push({ header: `${spec.path}.${language}`, sourcePath: spec.path, kind: spec.kind, language });
      }
    }
  }
  return specs;
}

/** Blueprint columns plus columns discovered in the exported pages' lect data. */
export function exportCsvPathSpecs(meta: ContentMeta, pageTypes: string[], lects: Lect[]): CsvPathSpec[] {
  const specs = new Map<string, CsvPathSpec>();
  for (const spec of csvPathSpecs(meta, pageTypes)) specs.set(spec.header, spec);
  for (const lect of lects) collectDataCsvPathSpecs(meta, lect, '', specs);
  return Array.from(specs.values());
}

function collectDataCsvPathSpecs(meta: ContentMeta, value: unknown, path: string, specs: Map<string, CsvPathSpec>): void {
  if (isCsvScalar(value)) {
    if (path) addDataCsvPathSpec(specs, { header: path, sourcePath: path, kind: dataCsvPathKind(path) });
    return;
  }

  if (Array.isArray(value)) {
    if (value.some(isCsvScalar)) {
      addDataCsvPathSpec(specs, { header: path, sourcePath: path, kind: dataCsvPathKind(path) });
    }
    for (const item of value) {
      if (isPlainRecord(item)) collectDataCsvPathSpecs(meta, item, `${path}[*]`, specs);
    }
    return;
  }

  if (!isPlainRecord(value)) return;

  const languageEntries = meta.languages.filter((language) => isCsvScalar(value[language]));
  if (path && languageEntries.length > 0) {
    for (const language of meta.languages) {
      addDataCsvPathSpec(specs, {
        header: `${path}.${language}`,
        sourcePath: path,
        kind: 'localized',
        language,
      });
    }
  }

  for (const [key, entry] of Object.entries(value)) {
    if (languageEntries.length > 0 && meta.languages.includes(key) && isCsvScalar(entry)) continue;
    if (shouldSkipDataCsvPath(key, path)) continue;
    collectDataCsvPathSpecs(meta, entry, childPath(path, key), specs);
  }
}

function childPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child;
}

function addDataCsvPathSpec(specs: Map<string, CsvPathSpec>, spec: CsvPathSpec): void {
  if (!spec.header || specs.has(spec.header)) return;
  specs.set(spec.header, spec);
}

function dataCsvPathKind(path: string): BlueprintPathKind {
  return path.startsWith('_pointers.') ? 'pointer' : 'scalar';
}

function isCsvScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function shouldSkipDataCsvPath(key: string, parentPath: string): boolean {
  return !parentPath && ['_modifier', '_type', '_updated_at'].includes(key);
}

// ── Lect path get/set ────────────────────────────────────────────────────────

function lectValueToCsvCell(value: unknown, defaultLanguage: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => lectValueToCsvCell(entry, defaultLanguage)).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const defaultValue = record[defaultLanguage];
    if (defaultValue !== undefined) return lectValueToCsvCell(defaultValue, defaultLanguage);
    const firstScalar = Object.values(record).find((entry) => (
      typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'
    ));
    if (firstScalar !== undefined) return String(firstScalar);
    return JSON.stringify(record);
  }
  return String(value);
}

function getPathValue(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function getLectValueByPath(lect: Lect, path: string, defaultLanguage: string): string {
  const wildcardMatch = path.match(/^(.+?)\[\*\]\.(.+)$/);
  if (wildcardMatch) {
    const items = getPathValue(lect, wildcardMatch[1]);
    if (!Array.isArray(items)) return '';
    return items.map((item) => getLectValueByPath(item as Lect, wildcardMatch[2], defaultLanguage)).filter(Boolean).join('; ');
  }

  return lectValueToCsvCell(getPathValue(lect, path), defaultLanguage);
}

function getCsvLectValue(lect: Lect, spec: CsvPathSpec, defaultLanguage: string): string {
  const path = spec.language ? `${spec.sourcePath}.${spec.language}` : spec.sourcePath;
  return getLectValueByPath(lect, path, defaultLanguage);
}

function ensureRecordPath(source: Record<string, unknown>, path: string): Record<string, unknown> {
  const segments = path.split('.').filter(Boolean);
  let current = source;
  for (const segment of segments) {
    if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  return current;
}

export function setLectPathValue(lect: Lect, path: string, kind: BlueprintPathKind, value: string, language: string): void {
  const wildcardMatch = path.match(/^(.+?)\[\*\]\.(.+)$/);
  if (wildcardMatch) {
    const [itemName, childPathValue] = [wildcardMatch[1], wildcardMatch[2]];
    const values = splitListValue(value);
    if (!Array.isArray(lect[itemName])) lect[itemName] = [];
    const items = lect[itemName] as LectItem[];
    values.forEach((entry, index) => {
      items[index] ||= {};
      setLectPathValue(items[index], childPathValue, kind, entry, language);
    });
    return;
  }

  if (kind === 'pointer') {
    const pointerPath = path.replace(/^_pointers\.?/, '');
    if (!isPlainRecord(lect._pointers)) lect._pointers = {};
    (lect._pointers as Record<string, unknown>)[pointerPath] = value;
    return;
  }

  const segments = path.split('.').filter(Boolean);
  const field = segments.pop();
  if (!field) return;
  const target = ensureRecordPath(lect as Record<string, unknown>, segments.join('.'));
  if (kind === 'localized') {
    const current = target[field];
    const values = current && typeof current === 'object' && !Array.isArray(current)
      ? current as Record<string, unknown>
      : {};
    target[field] = { ...values, [language]: value };
    return;
  }

  target[field] = value;
}

// ── Export ───────────────────────────────────────────────────────────────────

export function exportHeaders(pathColumns: CsvPathSpec[], taxonomies: Array<{ name: string }>): string[] {
  return [
    'id',
    'uuid',
    'name',
    'slug',
    'weight',
    'start',
    'end',
    'timezone',
    'page_type',
    ...pathColumns.map((spec) => spec.header),
    ...taxonomies.map((taxonomy) => `tag:${taxonomy.name}`),
  ];
}

function pageTagGroups(tags: PageTag[] | undefined): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const tag of tags ?? []) {
    groups[tag.taxonomy] ||= [];
    groups[tag.taxonomy].push(tag.name);
  }
  return groups;
}

export function buildExportCsv(meta: ContentMeta, pages: CmsPage[], pageTypes: string[]): string {
  const lects = pages.map((page) => (isPlainRecord(page.lect) ? page.lect as Lect : {}));
  const pathColumns = exportCsvPathSpecs(meta, pageTypes, lects);
  const headers = exportHeaders(pathColumns, meta.taxonomies);
  const rows = [headers];

  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const lect = lects[index];
    const tagGroups = pageTagGroups(page.tags);
    rows.push([
      String(page.id),
      page.uuid,
      page.name,
      page.slug,
      String(page.weight ?? ''),
      page.start ?? '',
      page.end ?? '',
      page.timezone ?? '',
      page.page_type ?? '',
      ...pathColumns.map((spec) => getCsvLectValue(lect, spec, meta.default_language)),
      ...meta.taxonomies.map((taxonomy) => (tagGroups[taxonomy.name] ?? []).join('; ')),
    ]);
  }

  return `﻿${rows.map((row) => row.map(csvFormatValue).join(',')).join('\n')}`;
}

export function csvDownloadResponse(csv: string, filename: string): Response {
  // Sanitize the ASCII fallback and RFC 5987-encode the full name so the
  // filename can never inject quotes/CR/LF into the header.
  const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;,]/g, '_');
  return new Response(csv, {
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Type': 'text/csv; charset=utf-8',
      'Expires': '0',
      'Pragma': 'no-cache',
    },
  });
}

// ── Import: classify & apply ─────────────────────────────────────────────────

export interface CsvImportPreviewRow {
  rowNumber: number;
  action: 'create' | 'update';
  name: string;
  slug: string;
  existingId: number | null;
  existingName: string;
  existingSlug: string;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export function importRowId(row: Record<string, string>): number | null {
  const id = row.id?.trim() ?? '';
  return /^-?\d+$/.test(id) ? parseInt(id, 10) : null;
}

/** Match each CSV row to an existing page by id (preferred) or slug — the host import's semantics. */
export function matchImportTargets(rows: Array<Record<string, string>>, existing: CmsPage[]): Map<number, CmsPage> {
  const byId = new Map<number, CmsPage>();
  const bySlug = new Map<string, CmsPage>();
  for (const page of existing) {
    if (!byId.has(page.id)) byId.set(page.id, page);
    if (page.slug && !bySlug.has(page.slug)) bySlug.set(page.slug, page);
  }

  const targets = new Map<number, CmsPage>();
  for (const [index, row] of rows.entries()) {
    const id = importRowId(row);
    const slug = row.slug?.trim() ?? '';
    const match = (id !== null ? byId.get(id) : undefined) ?? (slug ? bySlug.get(slug) : undefined);
    if (match) targets.set(index, match);
  }
  return targets;
}

export function previewImportRows(
  meta: ContentMeta,
  pageType: string,
  rows: Array<Record<string, string>>,
  targets: Map<number, CmsPage>,
): { rows: CsvImportPreviewRow[]; skipped: number } {
  const pathSpecs = csvPathSpecs(meta, [pageType], true);
  const preview: { rows: CsvImportPreviewRow[]; skipped: number } = { rows: [], skipped: 0 };

  for (const [index, row] of rows.entries()) {
    if (!csvRowHasValues(row)) {
      preview.skipped++;
      continue;
    }

    const existing = targets.get(index) ?? null;
    const lect: Lect = existing && isPlainRecord(existing.lect) ? structuredClone(existing.lect) as Lect : {};
    for (const spec of pathSpecs) {
      if (!(spec.header in row)) continue;
      setLectPathValue(lect, spec.sourcePath, spec.kind, row[spec.header] ?? '', spec.language ?? meta.default_language);
    }

    const name = row.name?.trim()
      || localizedName(lect, meta.default_language)
      || existing?.name
      || `Untitled ${pageType}`;
    const slug = row.slug?.trim() || existing?.slug || slugify(name);

    preview.rows.push({
      rowNumber: index + 2,
      action: existing ? 'update' : 'create',
      name,
      slug,
      existingId: existing?.id ?? null,
      existingName: existing?.name ?? '',
      existingSlug: existing?.slug ?? '',
    });
  }

  return preview;
}

function localizedName(lect: Lect, defaultLanguage: string): string {
  const name = lect.name;
  if (typeof name === 'string') return name.trim();
  if (isPlainRecord(name)) {
    const value = name[defaultLanguage];
    return typeof value === 'string' ? value.trim() : '';
  }
  return '';
}

/** Tag names referenced by a row, grouped for /__cms/tags/ensure. */
export function rowTagEntries(
  meta: ContentMeta,
  row: Record<string, string>,
): Array<{ taxonomy: string; name: string; taxonomyName: string }> {
  const entries: Array<{ taxonomy: string; name: string; taxonomyName: string }> = [];
  for (const taxonomy of meta.taxonomies) {
    const header = `tag:${taxonomy.name}`;
    const value = row[header] ?? row[taxonomy.name];
    if (value === undefined) continue;
    for (const name of splitListValue(value)) {
      entries.push({ taxonomy: taxonomy.slug, name, taxonomyName: taxonomy.name });
    }
  }
  return entries;
}

/** Taxonomy names whose tag column is present in a row (values may be empty = clear in replace mode). */
export function rowTagTaxonomies(meta: ContentMeta, row: Record<string, string>): Set<string> {
  const present = new Set<string>();
  for (const taxonomy of meta.taxonomies) {
    if (hasCsvColumn(row, `tag:${taxonomy.name}`) || hasCsvColumn(row, taxonomy.name)) present.add(taxonomy.name);
  }
  return present;
}

export interface PreparedCreate {
  page_type: string;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  lect: Lect;
  tags: number[];
}

export function prepareCreateFromRow(
  meta: ContentMeta,
  pageType: string,
  row: Record<string, string>,
  pathSpecs: CsvPathSpec[],
  ensuredTags: Map<string, number>,
): PreparedCreate {
  const lect: Lect = {};
  for (const spec of pathSpecs) {
    if (!hasCsvColumn(row, spec.header)) continue;
    setLectPathValue(lect, spec.sourcePath, spec.kind, row[spec.header] ?? '', spec.language ?? meta.default_language);
  }

  const name = row.name?.trim() || localizedName(lect, meta.default_language) || `Untitled ${pageType}`;
  const slug = row.slug?.trim() || slugify(name);
  const weight = csvCellHasValue(row.weight) && Number.isFinite(Number(row.weight)) ? Number(row.weight) : 5;

  return {
    page_type: pageType,
    name,
    slug,
    weight,
    start: row.start?.trim() || null,
    end: row.end?.trim() || null,
    timezone: row.timezone?.trim() || null,
    lect,
    tags: rowTagIds(meta, row, ensuredTags),
  };
}

function rowTagIds(meta: ContentMeta, row: Record<string, string>, ensuredTags: Map<string, number>): number[] {
  const ids: number[] = [];
  for (const entry of rowTagEntries(meta, row)) {
    const id = ensuredTags.get(`${entry.taxonomy} ${entry.name}`);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface PreparedUpdate {
  id: number;
  changed: boolean;
  input: {
    name?: string;
    slug?: string;
    weight?: number;
    start?: string | null;
    end?: string | null;
    timezone?: string | null;
    lect?: Lect;
    tags?: number[];
  };
}

/**
 * Applies a CSV row to an existing page, honouring append ("only fill blanks")
 * vs replace semantics — ported from the host's updateImportedPage. Returns
 * the partial PUT body; `changed: false` means the row is a no-op.
 */
export function prepareUpdateFromRow(
  meta: ContentMeta,
  pageType: string,
  row: Record<string, string>,
  existing: CmsPage,
  pathSpecs: CsvPathSpec[],
  mode: 'replace' | 'append',
  ensuredTags: Map<string, number>,
): PreparedUpdate {
  const lect: Lect = isPlainRecord(existing.lect) ? structuredClone(existing.lect) as Lect : {};
  let lectChanged = false;
  for (const spec of pathSpecs) {
    if (!hasCsvColumn(row, spec.header)) continue;
    const value = row[spec.header] ?? '';
    if (mode === 'append') {
      if (!csvCellHasValue(value)) continue;
      if (getCsvLectValue(lect, spec, meta.default_language).trim() !== '') continue;
    }
    setLectPathValue(lect, spec.sourcePath, spec.kind, value, spec.language ?? meta.default_language);
    lectChanged = true;
  }

  const input: PreparedUpdate['input'] = {};
  let changed = lectChanged;
  if (lectChanged) input.lect = lect;

  if (mode === 'append') {
    if (csvCellHasValue(row.name) && !existing.name?.trim()) {
      input.name = row.name.trim();
      changed = true;
    }
    if (csvCellHasValue(row.slug) && !existing.slug?.trim()) {
      input.slug = row.slug.trim();
      changed = true;
    }
    if (csvCellHasValue(row.weight) && (existing.weight === null || existing.weight === undefined)) {
      input.weight = Number(row.weight);
      changed = true;
    }
    if (csvCellHasValue(row.start) && !existing.start) {
      input.start = row.start.trim();
      changed = true;
    }
    if (csvCellHasValue(row.end) && !existing.end) {
      input.end = row.end.trim();
      changed = true;
    }
    if (csvCellHasValue(row.timezone) && !existing.timezone) {
      input.timezone = row.timezone.trim();
      changed = true;
    }
  } else {
    if (hasCsvColumn(row, 'name')) {
      input.name = row.name?.trim() || localizedName(lect, meta.default_language) || existing.name || `Untitled ${pageType}`;
      changed = true;
    }
    if (hasCsvColumn(row, 'slug')) {
      input.slug = row.slug?.trim() || existing.slug || slugify(input.name ?? existing.name ?? '');
      changed = true;
    }
    if (hasCsvColumn(row, 'weight') && csvCellHasValue(row.weight)) {
      input.weight = Number(row.weight);
      changed = true;
    }
    if (hasCsvColumn(row, 'start')) {
      input.start = row.start?.trim() || null;
      changed = true;
    }
    if (hasCsvColumn(row, 'end')) {
      input.end = row.end?.trim() || null;
      changed = true;
    }
    if (hasCsvColumn(row, 'timezone')) {
      input.timezone = row.timezone?.trim() || null;
      changed = true;
    }
  }

  const tags = updatedTagIds(meta, row, existing, mode, ensuredTags);
  if (tags) {
    input.tags = tags;
    changed = true;
  }

  return { id: existing.id, changed, input };
}

/**
 * The replacement tag-id set for an update, or null when no tag column is
 * present / nothing changes. Replace mode swaps out only the taxonomies whose
 * column appears in the CSV; append mode only adds.
 */
function updatedTagIds(
  meta: ContentMeta,
  row: Record<string, string>,
  existing: CmsPage,
  mode: 'replace' | 'append',
  ensuredTags: Map<string, number>,
): number[] | null {
  const presentTaxonomies = rowTagTaxonomies(meta, row);
  if (presentTaxonomies.size === 0) return null;

  const existingTags = existing.tags ?? [];
  const kept = mode === 'replace'
    ? existingTags.filter((tag) => !presentTaxonomies.has(tag.taxonomy))
    : existingTags;
  const ids = kept.map((tag) => tag.id);
  for (const id of rowTagIds(meta, row, ensuredTags)) {
    if (!ids.includes(id)) ids.push(id);
  }

  const before = existingTags.map((tag) => tag.id).sort((a, b) => a - b);
  const after = [...ids].sort((a, b) => a - b);
  if (before.length === after.length && before.every((id, i) => id === after[i])) return null;
  return ids;
}
