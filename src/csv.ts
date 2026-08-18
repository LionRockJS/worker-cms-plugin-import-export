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
  labelKey: string;
  descriptionKey: string;
  destructive: boolean;
}

export const CSV_IMPORT_MODE_OPTIONS: CsvImportModeOption[] = [
  {
    value: 'new-append',
    label: 'New + Add Missing Fields',
    description: 'Create new pages and fill empty fields or add tags on existing pages.',
    labelKey: 'import-export.import_modes.new_append.label',
    descriptionKey: 'import-export.import_modes.new_append.description',
    destructive: false,
  },
  {
    value: 'new',
    label: 'New Pages Only',
    description: 'Create only rows that do not match an existing draft page.',
    labelKey: 'import-export.import_modes.new.label',
    descriptionKey: 'import-export.import_modes.new.description',
    destructive: false,
  },
  {
    value: 'new-overwrite',
    label: 'New + Replace Existing Fields',
    description: 'Create new pages and replace matching fields on existing pages.',
    labelKey: 'import-export.import_modes.new_overwrite.label',
    descriptionKey: 'import-export.import_modes.new_overwrite.description',
    destructive: true,
  },
  {
    value: 'append',
    label: 'Existing Pages: Add Missing Fields',
    description: 'Only fill empty fields or add tags on existing pages.',
    labelKey: 'import-export.import_modes.append.label',
    descriptionKey: 'import-export.import_modes.append.description',
    destructive: false,
  },
  {
    value: 'overwrite',
    label: 'Existing Pages: Replace Fields',
    description: 'Only replace matching fields on existing pages.',
    labelKey: 'import-export.import_modes.overwrite.label',
    descriptionKey: 'import-export.import_modes.overwrite.description',
    destructive: true,
  },
  {
    value: 'force-new',
    label: 'Treat All Rows As New Pages',
    description: 'Create every CSV row as a new draft page, even when it matches an existing page.',
    labelKey: 'import-export.import_modes.force_new.label',
    descriptionKey: 'import-export.import_modes.force_new.description',
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

    // csvFormatValue protects numeric-looking cells as Excel string literals
    // (`="123"`). Treat the leading `=` + quote as CSV syntax so importing an
    // exported file yields `123`, rather than the unusable value `=123`.
    if (char === '=' && cell === '' && next === '"') {
      quoted = true;
      index++;
    } else if (char === '"') {
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

const DEFAULT_PAGE_WEIGHT = 5;

/** Returns a finite page weight from a CSV cell, or null when it is absent/invalid. */
function csvPageWeight(value: string | null | undefined): number | null {
  if (!csvCellHasValue(value)) return null;
  const weight = Number(value);
  return Number.isFinite(weight) ? weight : null;
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

/**
 * Blueprint columns plus safe specs inferred from the CSV headers themselves.
 *
 * Export discovers fields that are present in stored lect data (notably
 * structured `_blocks`). Import used to consider only the blueprint, which
 * meant an exported block field could silently disappear on re-import. Header
 * inference keeps those data-only fields round-trippable while reserving page
 * metadata and taxonomy columns for their dedicated handlers.
 */
export function csvImportPathSpecs(
  meta: ContentMeta,
  pageTypes: string[],
  headers: Iterable<string>,
  includeLegacyLocalized = true,
): CsvPathSpec[] {
  const specs = csvPathSpecs(meta, pageTypes, includeLegacyLocalized);
  const seen = new Set(specs.map((spec) => spec.header));
  const reserved = new Set([
    'id', 'uuid', 'name', 'slug', 'weight', 'start', 'end', 'timezone',
    'page_type', 'block_type',
  ]);

  for (const rawHeader of headers) {
    const header = rawHeader.trim();
    if (!header || seen.has(header) || reserved.has(header) || header.startsWith('tag:')) continue;

    const localizedMatch = header.match(/^(.+)\.([a-z0-9-]+)$/i);
    if (localizedMatch && meta.languages.includes(localizedMatch[2])) {
      specs.push({
        header,
        sourcePath: localizedMatch[1],
        kind: 'localized',
        language: localizedMatch[2],
      });
    } else {
      specs.push({
        header,
        sourcePath: header,
        kind: dataCsvPathKind(header),
      });
    }
    seen.add(header);
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
  return path.includes('_pointers.') ? 'pointer' : 'scalar';
}

function isCsvScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function shouldSkipDataCsvPath(key: string, parentPath: string): boolean {
  return !parentPath && ['_id', '_modifier', '_name', '_type', '_updated_at', '_weight'].includes(key);
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

/** Unique structured block-type slugs stored on a page, in first-seen order. */
export function blockTypesForLect(lect: Lect): string[] {
  if (!Array.isArray(lect._blocks)) return [];
  const types: string[] = [];
  for (const block of lect._blocks) {
    if (!isPlainRecord(block)) continue;
    const type = typeof block._type === 'string' ? block._type.trim() : '';
    if (type && !types.includes(type)) types.push(type);
  }
  return types;
}

export interface SetupPathSpec {
  path: string;
  kind: BlueprintPathKind;
}

type SetupBlueprintEntry = string | Record<string, SetupBlueprintEntry[]>;

/** Reconstructs a generic CMS blueprint from the path-only metadata of older hosts. */
function blueprintFromPathSpecs(specs: SetupPathSpec[]): unknown[] {
  const blueprint: SetupBlueprintEntry[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    const normalizedPath = spec.path.trim();
    if (!normalizedPath || seen.has(`${spec.kind}:${normalizedPath}`)) continue;
    seen.add(`${spec.kind}:${normalizedPath}`);

    const segments = normalizedPath.split('.').filter(Boolean);
    if (!segments.length) continue;
    const pointerIndex = segments.indexOf('_pointers');
    const fieldSegments = pointerIndex >= 0
      ? [...segments.slice(0, pointerIndex), ...segments.slice(pointerIndex + 1)]
      : segments;
    if (!fieldSegments.length) continue;

    const field = fieldSegments.pop()!;
    const fieldName = spec.kind === 'pointer' ? `*${field}` : spec.kind === 'scalar' ? `@${field}` : field;
    let target = blueprint;
    for (const segment of fieldSegments) {
      const repeatable = segment.endsWith('[*]');
      const key = repeatable ? segment.slice(0, -3) : segment;
      if (!key) continue;
      let child = target.find((entry): entry is Record<string, SetupBlueprintEntry[]> => (
        isPlainRecord(entry) && Array.isArray(entry[key])
      ));
      if (!child) {
        child = { [key]: [] };
        target.push(child);
      }
      target = child[key];
      if (!repeatable) continue;
    }
    if (!target.includes(fieldName)) target.push(fieldName);
  }

  return blueprint;
}

export interface ContentTypeSetupExport {
  format: '0xCMS content-type-setup';
  version: 1;
  languages: string[];
  default_language: string;
  taxonomies: Array<{ name: string; slug: string }>;
  page_types: Array<{
    page_type: string;
    name: string;
    blueprint: unknown[];
    blueprint_source: 'host' | 'observed-paths';
    block_types: string[];
    taxonomy_types: string[];
    path_specs: SetupPathSpec[];
  }>;
  block_types: Array<{
    block_type: string;
    name: string;
    blueprint: unknown[];
    blueprint_source: 'host' | 'observed-paths';
    path_specs: SetupPathSpec[];
  }>;
}

export interface ContentTypeSetupImportResult {
  setup: ContentTypeSetupExport | null;
  errors: string[];
  warnings: string[];
}

const CONTENT_TYPE_SETUP_FORMAT = '0xCMS content-type-setup';
const CONTENT_TYPE_SETUP_VERSION = 1;
const TYPE_SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * Validates and normalizes a type-setup export before it is shown to an
 * operator or sent to the destination CMS's type-admin forms. The importer
 * is deliberately create-only: an existing type is left untouched, so a
 * setup file cannot silently change a live site's blueprint.
 */
export function parseContentTypeSetupImport(input: string | unknown): ContentTypeSetupImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let raw: unknown = input;

  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return { setup: null, errors: ['The type setup file is not valid JSON.'], warnings };
    }
  }
  if (!isPlainRecord(raw)) {
    return { setup: null, errors: ['The type setup must be a JSON object.'], warnings };
  }

  if (raw.format !== CONTENT_TYPE_SETUP_FORMAT) {
    errors.push(`Unsupported type setup format. Expected "${CONTENT_TYPE_SETUP_FORMAT}".`);
  }
  if (raw.version !== CONTENT_TYPE_SETUP_VERSION) {
    errors.push(`Unsupported type setup version. Expected ${CONTENT_TYPE_SETUP_VERSION}.`);
  }

  const languages = setupStringList(raw.languages, 'languages', errors);
  const defaultLanguage = setupString(raw.default_language, 'default_language', errors);
  if (defaultLanguage && languages.length > 0 && !languages.includes(defaultLanguage)) {
    errors.push(`default_language "${defaultLanguage}" is not listed in languages.`);
  }

  const taxonomies = setupTaxonomies(raw.taxonomies, errors);
  const pageTypes = setupPageTypes(raw.page_types, errors);
  const blockTypes = setupBlockTypes(raw.block_types, errors);

  const pageSlugs = new Set(pageTypes.map((entry) => entry.page_type));
  const blockSlugs = new Set(blockTypes.map((entry) => entry.block_type));
  for (const pageType of pageTypes) {
    for (const blockType of pageType.block_types) {
      if (!blockSlugs.has(blockType)) {
        warnings.push(`Page type "${pageType.page_type}" references block type "${blockType}", which is not included in the file.`);
      }
    }
  }
  if (pageSlugs.size !== pageTypes.length) errors.push('The file contains duplicate page_type values.');
  if (blockSlugs.size !== blockTypes.length) errors.push('The file contains duplicate block_type values.');

  if (errors.length > 0) return { setup: null, errors, warnings };

  return {
    setup: {
      format: CONTENT_TYPE_SETUP_FORMAT,
      version: CONTENT_TYPE_SETUP_VERSION,
      languages,
      default_language: defaultLanguage,
      taxonomies,
      page_types: pageTypes,
      block_types: blockTypes,
    },
    errors,
    warnings,
  };
}

function setupString(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${path} must be a non-empty string.`);
    return '';
  }
  return value.trim();
}

function setupStringList(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of strings.`);
    return [];
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !item.trim()) {
      errors.push(`${path}[${index}] must be a non-empty string.`);
      continue;
    }
    const entry = item.trim();
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

function setupSlug(value: unknown, path: string, errors: string[]): string {
  const slug = setupString(value, path, errors);
  if (slug && !TYPE_SLUG_PATTERN.test(slug)) {
    errors.push(`${path} "${slug}" is not a CMS-safe slug (use lowercase letters, numbers, hyphens, or underscores).`);
  }
  return slug;
}

function setupBlueprint(value: unknown, path: string, errors: string[]): unknown[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be a JSON array.`);
    return [];
  }
  return value;
}

function setupPathSpecs(value: unknown, path: string, errors: string[]): SetupPathSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array.`);
    return [];
  }
  const specs: SetupPathSpec[] = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainRecord(item) || typeof item.path !== 'string' || !item.path.trim()) {
      errors.push(`${path}[${index}] must contain a non-empty path.`);
      continue;
    }
    if (item.kind !== 'scalar' && item.kind !== 'localized' && item.kind !== 'pointer') {
      errors.push(`${path}[${index}].kind must be scalar, localized, or pointer.`);
      continue;
    }
    specs.push({ path: item.path.trim(), kind: item.kind });
  }
  return specs;
}

function setupTaxonomies(value: unknown, errors: string[]): Array<{ name: string; slug: string }> {
  if (!Array.isArray(value)) {
    errors.push('taxonomies must be an array.');
    return [];
  }
  const taxonomies: Array<{ name: string; slug: string }> = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainRecord(item)) {
      errors.push(`taxonomies[${index}] must be an object.`);
      continue;
    }
    const slug = setupSlug(item.slug, `taxonomies[${index}].slug`, errors);
    const name = setupString(item.name, `taxonomies[${index}].name`, errors);
    if (slug && name && !taxonomies.some((entry) => entry.slug === slug)) taxonomies.push({ name, slug });
  }
  return taxonomies;
}

function setupPageTypes(value: unknown, errors: string[]): ContentTypeSetupExport['page_types'] {
  if (!Array.isArray(value)) {
    errors.push('page_types must be an array.');
    return [];
  }
  const pageTypes: ContentTypeSetupExport['page_types'] = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainRecord(item)) {
      errors.push(`page_types[${index}] must be an object.`);
      continue;
    }
    const pageType = setupSlug(item.page_type, `page_types[${index}].page_type`, errors);
    const name = setupString(item.name, `page_types[${index}].name`, errors);
    const blueprint = setupBlueprint(item.blueprint, `page_types[${index}].blueprint`, errors);
    const blockTypes = setupStringList(item.block_types ?? item.block_lists, `page_types[${index}].block_types`, errors);
    const taxonomyTypes = setupStringList(item.taxonomy_types ?? item.taxonomy_lists, `page_types[${index}].taxonomy_types`, errors);
    const pathSpecs = setupPathSpecs(item.path_specs, `page_types[${index}].path_specs`, errors);
    if (!pageType || !name) continue;
    pageTypes.push({
      page_type: pageType,
      name,
      blueprint,
      blueprint_source: item.blueprint_source === 'host' ? 'host' : 'observed-paths',
      block_types: blockTypes,
      taxonomy_types: taxonomyTypes,
      path_specs: pathSpecs,
    });
  }
  return pageTypes;
}

function setupBlockTypes(value: unknown, errors: string[]): ContentTypeSetupExport['block_types'] {
  if (!Array.isArray(value)) {
    errors.push('block_types must be an array.');
    return [];
  }
  const blockTypes: ContentTypeSetupExport['block_types'] = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainRecord(item)) {
      errors.push(`block_types[${index}] must be an object.`);
      continue;
    }
    const blockType = setupSlug(item.block_type, `block_types[${index}].block_type`, errors);
    const name = setupString(item.name, `block_types[${index}].name`, errors);
    const blueprint = setupBlueprint(item.blueprint, `block_types[${index}].blueprint`, errors);
    const pathSpecs = setupPathSpecs(item.path_specs, `block_types[${index}].path_specs`, errors);
    if (!blockType || !name) continue;
    blockTypes.push({
      block_type: blockType,
      name,
      blueprint,
      blueprint_source: item.blueprint_source === 'host' ? 'host' : 'observed-paths',
      path_specs: pathSpecs,
    });
  }
  return blockTypes;
}

/**
 * Builds a small, machine-readable inventory for recreating content types on
 * another CMS host. Newer hosts may provide raw blueprints through
 * `content-meta`; older hosts still get page/block names and observed field
 * paths, which is enough to identify the missing setup before importing pages.
 */
export function buildContentTypeSetupExport(meta: ContentMeta, pages: CmsPage[]): ContentTypeSetupExport {
  const pageLectsByType = new Map<string, Lect[]>();
  const blockLectsByType = new Map<string, Lect[]>();

  for (const page of pages) {
    const pageType = (page.page_type ?? '').trim();
    const lect = isPlainRecord(page.lect) ? page.lect as Lect : {};
    if (pageType) {
      const pageLects = pageLectsByType.get(pageType) ?? [];
      pageLects.push(lect);
      pageLectsByType.set(pageType, pageLects);
    }
    if (!Array.isArray(lect._blocks)) continue;
    for (const block of lect._blocks) {
      if (!isPlainRecord(block)) continue;
      const blockType = typeof block._type === 'string' ? block._type.trim() : '';
      if (!blockType) continue;
      const blockLects = blockLectsByType.get(blockType) ?? [];
      blockLects.push(block as Lect);
      blockLectsByType.set(blockType, blockLects);
    }
  }

  const pageTypes = [...new Set([...meta.page_types, ...pageLectsByType.keys()])];
  const pageTypeEntries = pageTypes.map((pageType) => {
    const definition = meta.page_type_definitions?.[pageType];
    const pageSpecs = meta.path_specs[pageType] ?? [];
    const blockTypes = new Set<string>(definition?.block_types ?? definition?.block_lists ?? []);
    for (const lect of pageLectsByType.get(pageType) ?? []) {
      for (const blockType of blockTypesForLect(lect)) blockTypes.add(blockType);
    }
    return {
      page_type: pageType,
      name: definition?.name ?? pageType,
      blueprint: definition?.blueprint ?? blueprintFromPathSpecs(pageSpecs),
      blueprint_source: definition?.blueprint ? 'host' as const : 'observed-paths' as const,
      block_types: [...blockTypes],
      taxonomy_types: definition?.taxonomy_types ?? definition?.taxonomy_lists ?? meta.taxonomies.map((taxonomy) => taxonomy.slug),
      path_specs: pageSpecs,
    };
  });

  const blockTypes = [...new Set([
    ...Object.keys(meta.block_type_definitions ?? {}),
    ...pageTypeEntries.flatMap((entry) => entry.block_types),
    ...blockLectsByType.keys(),
  ])];
  const blockTypeEntries = blockTypes.map((blockType) => {
    const definition = meta.block_type_definitions?.[blockType];
    const specs = new Map<string, SetupPathSpec>();
    for (const lect of blockLectsByType.get(blockType) ?? []) {
      const discovered = new Map<string, CsvPathSpec>();
      collectDataCsvPathSpecs(meta, lect, '', discovered);
      for (const spec of discovered.values()) {
        if (!spec.sourcePath || (spec.sourcePath.startsWith('_') && !spec.sourcePath.startsWith('_pointers.'))) continue;
        specs.set(spec.sourcePath, { path: spec.sourcePath, kind: spec.kind });
      }
    }
    return {
      block_type: blockType,
      name: definition?.name ?? blockType,
      blueprint: definition?.blueprint ?? blueprintFromPathSpecs([...specs.values()]),
      blueprint_source: definition?.blueprint ? 'host' as const : 'observed-paths' as const,
      path_specs: [...specs.values()],
    };
  });

  return {
    format: '0xCMS content-type-setup',
    version: 1,
    languages: [...meta.languages],
    default_language: meta.default_language,
    taxonomies: [...meta.taxonomies],
    page_types: pageTypeEntries,
    block_types: blockTypeEntries,
  };
}

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
    'block_type',
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
      blockTypesForLect(lect).join('; '),
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

export function jsonDownloadResponse(value: unknown, filename: string): Response {
  const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;,]/g, '_');
  return new Response(JSON.stringify(value, null, 2), {
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Type': 'application/json; charset=utf-8',
      'Expires': '0',
      'Pragma': 'no-cache',
    },
  });
}

// ── Import: classify & apply ─────────────────────────────────────────────────

export interface CsvImportPreviewRow {
  rowNumber: number;
  pageType: string;
  action: 'create' | 'update';
  name: string;
  slug: string;
  existingId: number | null;
  existingName: string;
  existingSlug: string;
}

/** Sentinel page type for the mixed-type import mode ("Import all page types"). */
export const ALL_PAGE_TYPES = 'all';

/** One importable CSV row with its resolved page type. */
export interface CsvRowEntry {
  /** 1-based CSV line number (line 1 is the header). */
  rowNumber: number;
  row: Record<string, string>;
  pageType: string;
}

/**
 * Resolves each CSV row to a page type: the row's own `page_type` column wins,
 * otherwise the import page's type (none in all-types mode). Empty rows and
 * rows whose type is unknown/unreadable are skipped, so a typo in `page_type`
 * can never mint a junk type.
 */
export function resolveImportEntries(
  meta: ContentMeta,
  rows: Array<Record<string, string>>,
  fallbackType: string,
): { entries: CsvRowEntry[]; skippedEmpty: number; skippedUnknownType: number } {
  const validTypes = new Set(meta.page_types);
  const entries: CsvRowEntry[] = [];
  let skippedEmpty = 0;
  let skippedUnknownType = 0;

  for (const [index, row] of rows.entries()) {
    if (!csvRowHasValues(row)) {
      skippedEmpty++;
      continue;
    }
    const requested = (row.page_type ?? '').trim();
    const pageType = requested || (fallbackType === ALL_PAGE_TYPES ? '' : fallbackType);
    if (!pageType || !validTypes.has(pageType)) {
      skippedUnknownType++;
      continue;
    }
    entries.push({ rowNumber: index + 2, row, pageType });
  }

  return { entries, skippedEmpty, skippedUnknownType };
}

/** Entries grouped by resolved page type, preserving row order within a group. */
export function groupEntriesByType(entries: CsvRowEntry[]): Map<string, CsvRowEntry[]> {
  const groups = new Map<string, CsvRowEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.pageType) ?? [];
    group.push(entry);
    groups.set(entry.pageType, group);
  }
  return groups;
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

/**
 * Match each entry to an existing page by id (preferred) or slug — the host
 * import's semantics. Returns matches keyed by CSV row number; pass entries
 * and pages of ONE page type so a slug can't match across types.
 */
export function matchImportTargets(entries: CsvRowEntry[], existing: CmsPage[]): Map<number, CmsPage> {
  const byId = new Map<number, CmsPage>();
  const bySlug = new Map<string, CmsPage>();
  for (const page of existing) {
    if (!byId.has(page.id)) byId.set(page.id, page);
    if (page.slug && !bySlug.has(page.slug)) bySlug.set(page.slug, page);
  }

  const targets = new Map<number, CmsPage>();
  for (const entry of entries) {
    const id = importRowId(entry.row);
    const slug = entry.row.slug?.trim() ?? '';
    const match = (id !== null ? byId.get(id) : undefined) ?? (slug ? bySlug.get(slug) : undefined);
    if (match) targets.set(entry.rowNumber, match);
  }
  return targets;
}

/** Preview rows for entries of one page type; `targets` is keyed by row number. */
export function previewImportRows(
  meta: ContentMeta,
  entries: CsvRowEntry[],
  targets: Map<number, CmsPage>,
): CsvImportPreviewRow[] {
  const preview: CsvImportPreviewRow[] = [];
  const specsByType = new Map<string, CsvPathSpec[]>();

  for (const entry of entries) {
    const { row, pageType } = entry;
    let pathSpecs = specsByType.get(pageType);
    if (!pathSpecs) {
      pathSpecs = csvImportPathSpecs(meta, [pageType], Object.keys(row), true);
      specsByType.set(pageType, pathSpecs);
    }

    const existing = targets.get(entry.rowNumber) ?? null;
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

    preview.push({
      rowNumber: entry.rowNumber,
      pageType,
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

/** Applies the explicit block_type metadata column to a lect. */
function setBlockTypesFromRow(lect: Lect, row: Record<string, string>, mode: 'replace' | 'append'): boolean {
  if (!hasCsvColumn(row, 'block_type')) return false;
  const requested = splitListValue(row.block_type ?? '');
  const current = Array.isArray(lect._blocks)
    ? lect._blocks.filter(isPlainRecord) as Lect[]
    : [];

  if (mode === 'append' && current.length > 0) return false;

  const before = JSON.stringify(lect._blocks ?? null);
  if (requested.length === 0) {
    delete lect._blocks;
  } else {
    lect._blocks = requested.map((type, index) => ({
      ...(current[index] ?? {}),
      _type: type,
    }));
  }
  return before !== JSON.stringify(lect._blocks ?? null);
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
  setBlockTypesFromRow(lect, row, 'replace');
  for (const spec of pathSpecs) {
    if (!hasCsvColumn(row, spec.header)) continue;
    setLectPathValue(lect, spec.sourcePath, spec.kind, row[spec.header] ?? '', spec.language ?? meta.default_language);
  }

  const name = row.name?.trim() || localizedName(lect, meta.default_language) || `Untitled ${pageType}`;
  const slug = row.slug?.trim() || slugify(name);
  const weight = csvPageWeight(row.weight) ?? DEFAULT_PAGE_WEIGHT;

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
  let lectChanged = setBlockTypesFromRow(lect, row, mode);
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
    const weight = csvPageWeight(row.weight);
    // Pages have a non-null database default (5), so checking only for null
    // means the default import mode can never carry an exported weight onto a
    // matching destination page. Treat the default as an empty weight, while
    // preserving a deliberately non-default destination value in append mode.
    if (weight !== null && (existing.weight === null || existing.weight === undefined || Number(existing.weight) === DEFAULT_PAGE_WEIGHT)) {
      input.weight = weight;
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
    const weight = csvPageWeight(row.weight);
    if (hasCsvColumn(row, 'weight') && weight !== null) {
      input.weight = weight;
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
