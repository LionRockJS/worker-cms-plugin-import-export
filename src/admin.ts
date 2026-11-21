import { readImportSheets, sheetObjects, objectsCsv, ImportValidationError, IMPORT_MAX_BYTES } from './import-upload';
import { legacyContactRow, isLegacyContactRow, matchLegacyContacts, legacyContactChanges } from './legacy-contacts';
import { vcardRows } from './vcard';
// ============================================================
// Admin UI — proxied by the CMS at /admin/plugins/import-export/<rest>.
//
// Routes (rest after /__plugin/admin):
//   GET  ""                          → home: per-type import/export index
//   GET  export?page_type=X          → CSV download (all pages of X; omit = every type)
//   GET  export-types                → JSON page/block type setup inventory
//   GET  import-types                 → type setup JSON upload form
//   POST import-types                 → validate + preview type setup
//   GET  export-search?<as-query>    → CSV of an admin advanced-search result
//   GET  import/<type>               → upload form
//   POST import/<type>               → parse + classify → preview/confirm view
//   POST import/<type>/confirm       → apply (budgeted; renders a Continue view
//                                      when a pass stops early, like the events
//                                      plugin's resumable guest import)
//
// Confirmation applies a staged upload in passes.
// ============================================================

import { adminView, notFoundView, parseCmsUser, redirect, serveViewAsset } from '@lionrockjs/worker-cms-plugin';
import { CmsApiError, CmsClient, CREATE_BATCH_SIZE, ENSURE_TAGS_CHUNK, ENSURE_TAXONOMIES_CHUNK, tagKey, type CmsPage, type ContentMeta, type SearchCriterion } from './cms';
import type { ImportSession } from './import-session';
import {
  ALL_PAGE_TYPES,
  buildContentTypeSetupExport,
  buildExportCsv,
  csvDownloadResponse,
  csvImportPathSpecs,
  csvImportMode,
  csvImportModeOptions,
  csvPathSpecs,
  csvRowsToObjects,
  exportHeaders,
  groupEntriesByType,
  importRowId,
  jsonDownloadResponse,
  matchImportTargets,
  parseCsv,
  parseContentTypeSetupImport,
  prepareCreateFromRow,
  prepareUpdateFromRow,
  previewImportRows,
  resolveImportEntries,
  rowTagEntries,
  type CsvImportMode,
  type CsvRowEntry,
  type ContentTypeSetupExport,
  type PreparedCreate,
} from './csv';

export interface AdminEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  CMS_TENANT_ID?: string;
  IMPORT_SESSIONS: DurableObjectNamespace<ImportSession>;
  VIEWS: Fetcher;
}

/** Base path of this plugin's admin UI on the CMS origin (forms/links must use it). */
const BASE = '/admin/plugins/import-export';

/** Write calls allowed per confirm pass. */
const WRITE_BUDGET = 40;
// Return a continuation after at most four full create batches, even on fast requests.
const CONFIRM_ROW_LIMIT = 100;
// Leave time for the final batch and response before the CMS proxy's 15-second deadline.
const CONFIRM_WORK_MS = 8_000;
const TYPE_SETUP_MAX_BYTES = 4 * 1024 * 1024;

export async function handleAdmin(request: Request, env: AdminEnv, url: URL): Promise<Response> {
  const rest = url.pathname.slice('/__plugin/admin'.length).replace(/^\/+|\/+$/g, '');
  const segments = rest.split('/').filter(Boolean);

  // Browser-fetched client-view files: the host proxies
  // /admin/plugins/import-export/views/* here as /__plugin/admin/views/*.
  if (segments[0] === 'views') {
    return serveViewAsset(env.VIEWS, `/${segments.slice(1).join('/')}`);
  }
  if (segments[0] === 'assets') {
    return serveViewAsset(env.VIEWS, `/${segments.join('/')}`);
  }

  const user = parseCmsUser(request.headers.get('x-cms-user'));

  let cms: CmsClient;
  try {
    cms = new CmsClient(env).actAs(user.id);
  } catch {
    return adminView(env.VIEWS, 'Import / Export', 'error', {
      heading: 'Not configured',
      headingKey: 'import-export.views.error.not_configured',
      message: 'CMS_URL / PLUGIN_SECRET are not configured for this plugin Worker.',
      messageKey: 'import-export.views.error.not_configured_message',
      showConfig: true,
    });
  }

  try {
    if (segments.length === 0) return await home(cms, env);

    if (segments[0] === 'export' && request.method === 'GET') {
      return await exportPages(cms, url.searchParams.get('page_type') ?? segments[1] ?? '');
    }
    if (segments[0] === 'export-types' && request.method === 'GET') {
      return await exportTypeSetup(cms);
    }
    if (segments[0] === 'import-types') {
      if (request.method === 'GET') return await importTypeSetupForm(cms, env);
      if (request.method === 'POST') return await importTypeSetupPreview(cms, env, request);
    }
    if (segments[0] === 'export-search' && request.method === 'GET') {
      return await exportSearch(cms, url);
    }
    if (segments[0] === 'import' && segments[1]) {
      const pageType = decodeURIComponent(segments[1]);
      if (request.method === 'GET') return await importForm(cms, env, pageType);
      if (request.method === 'POST') {
        if (!user.id) return new Response('Import requires a signed-in user.', { status: 403 });
        if (segments[2] === 'confirm') return await importConfirm(env, request, pageType, user.id);
        return await importPreview(cms, env, request, pageType, user.id);
      }
    }

    return notFoundView(env.VIEWS);
  } catch (error) {
    return importErrorView(env.VIEWS, error);
  }
}

export function importErrorView(views: Fetcher, error: unknown): Promise<Response> {
  if (error instanceof ImportValidationError) return adminView(views, 'Import needs attention', 'error', { heading: 'Import needs attention', message: error.message });
  if (error instanceof CmsApiError) {
    const approvalHint = error.path === '/taxonomies/ensure' && (error.status === 404 || error.status === 405)
      ? ' Update the destination CMS to enable automatic taxonomy creation, or create the missing taxonomies in its admin first.'
      : error.code === 'forbidden_page_type'
        ? ' In Plugins → Import / Export → Page types, approve Read for All page types to load the form and Write to apply imports.'
        : '';
    return adminView(views, 'Import / Export', 'error', {
      heading: 'CMS request failed',
      headingKey: 'import-export.views.error.cms_request_failed',
      message: `The CMS responded ${error.status} (${error.code}) on ${error.method} ${error.path}.${approvalHint}`,
    });
  }
  throw error;
}

export function importSessionErrorView(
  views: Fetcher, reason: 'expired' | 'running' | 'interrupted' | 'review_required',
): Promise<Response> {
  return adminView(views, 'Import needs attention', 'error', {
    headingKey: 'import-export.views.error.import_needs_attention',
    messageKey: `import-export.views.error.import_session_${reason}`,
  });
}

// ── Home ─────────────────────────────────────────────────────────────────────

async function home(cms: CmsClient, env: AdminEnv): Promise<Response> {
  const meta = await cms.meta('all');
  return adminView(env.VIEWS, 'Import / Export', 'home', {
    pageTypes: meta.page_types.map((pageType) => ({
      pageType,
      importHref: `${BASE}/import/${encodeURIComponent(pageType)}`,
      exportHref: `${BASE}/export?page_type=${encodeURIComponent(pageType)}`,
      listHref: `/admin/pages/list/${encodeURIComponent(pageType)}`,
    })),
    exportAllHref: `${BASE}/export`,
    exportTypesHref: `${BASE}/export-types`,
    importTypesHref: `${BASE}/import-types`,
    importAllHref: `${BASE}/import/${ALL_PAGE_TYPES}`,
  });
}

// ── Export ───────────────────────────────────────────────────────────────────

async function exportPages(cms: CmsClient, pageType: string): Promise<Response> {
  const requested = pageType.trim();
  const meta = await cms.meta(requested ? [requested] : 'all');
  const types = requested ? [requested] : meta.page_types;

  const pages: CmsPage[] = [];
  for (const type of types) {
    pages.push(...await cms.listAll(type, { includeTags: true }));
  }
  sortForExport(pages, !requested);

  const csv = buildExportCsv(meta, pages, types);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return csvDownloadResponse(csv, `${requested || 'pages'}-export-${stamp}.csv`);
}

async function exportTypeSetup(cms: CmsClient): Promise<Response> {
  const meta = await cms.meta('all');
  const pages: CmsPage[] = [];
  for (const pageType of meta.page_types) {
    pages.push(...await cms.listAll(pageType));
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return jsonDownloadResponse(
    {
      ...buildContentTypeSetupExport(meta, pages),
      exported_at: new Date().toISOString(),
    },
    `content-types-export-${stamp}.json`,
  );
}

// ── Type setup import ───────────────────────────────────────────────────────

async function importTypeSetupForm(cms: CmsClient, env: AdminEnv, error = ''): Promise<Response> {
  // Keep the form cheap: the destination inventory is only needed after a
  // valid file has been submitted and is rendered on the preview screen.
  void cms;
  return adminView(env.VIEWS, 'Import type setup', 'type-import', {
    isConfirmTypeImport: false,
    action: `${BASE}/import-types`,
    backHref: BASE,
    importError: error,
    hasImportError: Boolean(error),
  });
}

async function importTypeSetupPreview(cms: CmsClient, env: AdminEnv, request: Request): Promise<Response> {
  const form = await request.formData();
  const file = form.get('file');
  let jsonText = typeof form.get('json') === 'string' ? String(form.get('json')) : '';
  if (file && typeof file === 'object' && 'text' in file && (file as File).size > 0) {
    if ((file as File).size > TYPE_SETUP_MAX_BYTES) {
      return importTypeSetupForm(cms, env, `The type setup file is too large. The maximum is ${TYPE_SETUP_MAX_BYTES / 1024 / 1024} MB.`);
    }
    jsonText = await (file as File).text();
  }
  if (new TextEncoder().encode(jsonText).byteLength > TYPE_SETUP_MAX_BYTES) {
    return importTypeSetupForm(cms, env, `The type setup file is too large. The maximum is ${TYPE_SETUP_MAX_BYTES / 1024 / 1024} MB.`);
  }
  if (!jsonText.trim()) return importTypeSetupForm(cms, env, 'Choose a JSON file or paste the exported type setup first.');

  const parsed = parseContentTypeSetupImport(jsonText);
  if (!parsed.setup) {
    return importTypeSetupForm(cms, env, [...parsed.errors, ...parsed.warnings].join(' '));
  }

  const meta = await cms.meta('all');
  const setup = setupForDestination(parsed.setup, meta);
  const existingPageTypes = new Set(meta.page_types);
  const existingBlockTypes = new Set(Object.keys(meta.block_type_definitions ?? {}));
  const pageTypes = setup.page_types.map((type) => ({
    kind: 'page',
    slug: type.page_type,
    name: type.name,
    status: existingPageTypes.has(type.page_type)
      ? 'existing'
      : 'create',
    blueprintJson: JSON.stringify(type.blueprint),
    blockTypes: type.block_types,
    taxonomyTypes: type.taxonomy_types,
  }));
  const blockTypes = setup.block_types.map((type) => ({
    kind: 'block',
    slug: type.block_type,
    name: type.name,
    // Older hosts do not return block slugs in content-meta, so the browser
    // bulk importer refreshes /admin/block_types before deciding to create.
    status: existingBlockTypes.has(type.block_type)
      ? 'existing'
      : 'create',
    blueprintJson: JSON.stringify(type.blueprint),
  }));
  const warnings = [
    ...parsed.warnings,
    ...setupImportWarnings(parsed.setup, meta),
  ];

  return adminView(env.VIEWS, 'Import type setup', 'type-import', {
    isConfirmTypeImport: true,
    action: `${BASE}/import-types`,
    backHref: BASE,
    setupJson: JSON.stringify(setup),
    pageTypes,
    blockTypes,
    warnings,
    hasWarnings: warnings.length > 0,
    pageTypeCount: pageTypes.length,
    blockTypeCount: blockTypes.length,
    createPageTypeCount: pageTypes.filter((type) => type.status === 'create').length,
    createBlockTypeCount: blockTypes.filter((type) => type.status === 'create').length,
    hasPageTypes: pageTypes.length > 0,
    hasBlockTypes: blockTypes.length > 0,
    importAssetHref: `${BASE}/assets/type-import.js`,
  });
}

/** Do not write taxonomy rows here; only keep page selections that exist on the destination. */
function setupForDestination(setup: ContentTypeSetupExport, meta: ContentMeta): ContentTypeSetupExport {
  const taxonomies = new Set(meta.taxonomies.map((taxonomy) => taxonomy.slug));
  return {
    ...setup,
    page_types: setup.page_types.map((type) => ({
      ...type,
      taxonomy_types: type.taxonomy_types.filter((slug) => taxonomies.has(slug)),
    })),
  };
}

function setupImportWarnings(setup: ContentTypeSetupExport, meta: ContentMeta): string[] {
  const warnings: string[] = [];
  const targetTaxonomies = new Set(meta.taxonomies.map((taxonomy) => taxonomy.slug));
  const missingTaxonomies = setup.taxonomies
    .map((taxonomy) => taxonomy.slug)
    .filter((slug) => !targetTaxonomies.has(slug));
  if (missingTaxonomies.length > 0) {
    warnings.push(`These taxonomies are not present on the destination and will not be selected: ${missingTaxonomies.join(', ')}.`);
  }
  if (setup.default_language !== meta.default_language || setup.languages.some((language) => !meta.languages.includes(language))) {
    warnings.push('The destination language configuration differs; type blueprints will be imported, but languages are not changed by this feature.');
  }
  return warnings;
}

/** Mirrors the host page-list export ordering: weight then name (type first when exporting all). */
function sortForExport(pages: CmsPage[], byType: boolean): void {
  pages.sort((a, b) => {
    if (byType) {
      const typeOrder = (a.page_type ?? '').localeCompare(b.page_type ?? '');
      if (typeOrder !== 0) return typeOrder;
    }
    const aWeight = Number.isFinite(Number(a.weight)) ? Number(a.weight) : Number.MAX_SAFE_INTEGER;
    const bWeight = Number.isFinite(Number(b.weight)) ? Number(b.weight) : Number.MAX_SAFE_INTEGER;
    if (aWeight !== bWeight) return aWeight - bWeight;
    return (a.name ?? '').localeCompare(b.name ?? '');
  });
}

/**
 * CSV of an admin advanced-search result. Accepts the exact query string of
 * the admin advanced-search page (search1/path1/tags1…, operator, page_type,
 * sort, order) so the host can link here with its current criteria.
 */
async function exportSearch(cms: CmsClient, url: URL): Promise<Response> {
  const criteria = parseSearchCriteria(url);
  const selectedPageType = (url.searchParams.get('page_type') ?? 'all').trim() || 'all';
  const operatorParam = (url.searchParams.get('operator') ?? '').toUpperCase();
  const operator = operatorParam === 'OR' || operatorParam === 'NOT' ? operatorParam : 'AND';
  const sort = (url.searchParams.get('sort') ?? '').trim() || undefined;
  const order = (url.searchParams.get('order') ?? '').toUpperCase() === 'ASC' ? 'ASC' as const : 'DESC' as const;

  const pages: CmsPage[] = [];
  let pageTypes: string[] = [];
  if (criteria.length) {
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const result = await cms.search({
        criteria,
        page_types: selectedPageType === 'all' ? undefined : [selectedPageType],
        operator,
        sort,
        order,
        limit: 500,
        page,
        include_tags: true,
      });
      pages.push(...result.pages);
      totalPages = result.pagination.totalPages;
      page = result.pagination.currentPage + 1;
    }
    pageTypes = [...new Set(pages.map((p) => p.page_type ?? ''))].filter(Boolean);
  }

  const meta = await cms.meta(selectedPageType === 'all' ? 'all' : [selectedPageType]);
  const columnTypes = selectedPageType === 'all' ? pageTypes : [selectedPageType];
  const csv = buildExportCsv(meta, pages, columnTypes);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return csvDownloadResponse(csv, `${selectedPageType === 'all' ? 'pages' : selectedPageType}-export-${stamp}.csv`);
}

/** Ported from the host's parseAdvancedSearchCriteria (utils/search.ts). */
function parseSearchCriteria(url: URL): SearchCriterion[] {
  const params = url.searchParams;
  const indexes = new Set<number>();
  for (const key of params.keys()) {
    const match = key.match(/^(?:search|path|tags)(\d+)$/);
    if (match) indexes.add(parseInt(match[1], 10));
  }

  const criteria: SearchCriterion[] = [];
  for (const index of [...indexes].sort((left, right) => left - right)) {
    const term = (params.get(`search${index}`) ?? '').trim();
    const path = (params.get(`path${index}`) ?? '').trim();
    const tags = params.getAll(`tags${index}`)
      .flatMap((value) => value.split(','))
      .map((tag) => tag.trim())
      .filter((tag) => /^\d+$/.test(tag));
    if (term || tags.length) criteria.push({ term, path, tags: Array.from(new Set(tags)) });
  }
  return criteria;
}

// ── Import ───────────────────────────────────────────────────────────────────

/** Label + back link for an import scope ('all' = the mixed, all-types mode). */
function importScope(pageType: string): { isAll: boolean; label: string; backHref: string } {
  const isAll = pageType === ALL_PAGE_TYPES;
  return {
    isAll,
    label: isAll ? 'all page types' : pageType,
    backHref: isAll ? '/admin/pages/list' : `/admin/pages/list/${encodeURIComponent(pageType)}`,
  };
}

async function importForm(cms: CmsClient, env: AdminEnv, pageType: string): Promise<Response> {
  const scope = importScope(pageType);
  const meta = await cms.meta(scope.isAll ? 'all' : [pageType]);
  // The all-types sample shows only the shared columns — each row picks its
  // blueprint columns via its page_type value.
  const sampleColumns = scope.isAll ? [] : csvPathSpecs(meta, [pageType]);
  return adminView(env.VIEWS, `Import ${scope.label}`, 'import', {
    pageType: scope.label,
    isConfirmImport: false,
    isAllTypes: scope.isAll,
    legacyContacts: pageType === 'contact',
    action: `${BASE}/import/${encodeURIComponent(pageType)}`,
    backHref: scope.backHref,
    sampleCsvHeader: exportHeaders(sampleColumns, meta.taxonomies).join(','),
  });
}

/**
 * Rows resolved to types (a row's own page_type column wins over the URL's
 * type) with per-type import targets, keyed by CSV row number.
 */
async function matchEntries(
  cms: CmsClient,
  meta: ContentMeta,
  entries: CsvRowEntry[],
  includeTags: boolean,
): Promise<Map<number, CmsPage>> {
  const targets = new Map<number, CmsPage>();
  for (const [type, group] of groupEntriesByType(entries)) {
    const legacy = group.filter(isLegacyContactEntry);
    const native = group.filter(entry => !isLegacyContactEntry(entry));
    if (native.length) for (const [rowNumber, page] of matchImportTargets(native, await lookupTargets(cms, type, native, includeTags))) targets.set(rowNumber, page);
    if (legacy.length) {
      const existing = await cms.listAll('contact', { includeTags });
      for (const [rowNumber, page] of matchLegacyContacts(legacy, existing, meta)) targets.set(rowNumber, page);
    }
  }
  return targets;
}

function isLegacyContactEntry(entry: CsvRowEntry): boolean {
  return entry.pageType === 'contact' && entry.row._eventuai_contact === '1';
}

function importSession(env: AdminEnv, userId: string, pageType: string, importId: string) {
  return env.IMPORT_SESSIONS.getByName(JSON.stringify([env.CMS_TENANT_ID ?? env.CMS_URL, userId, pageType, importId]));
}

async function importPreview(cms: CmsClient, env: AdminEnv, request: Request, pageType: string, userId: string): Promise<Response> {
  const form = await request.formData();
  const file = form.get('file');
  const meta = await cms.meta('all');
  let csvText = typeof form.get('csv') === 'string' ? String(form.get('csv')) : '';
  if (file && typeof file === 'object' && 'text' in file && (file as File).size > 0) {
    if ((file as File).size > IMPORT_MAX_BYTES) throw new ImportValidationError('The import file exceeds 10 MB.');
    const rows = /\.vcf$/i.test((file as File).name)
      ? (pageType === 'contact' ? vcardRows(await (file as File).text()) : (() => { throw new ImportValidationError('Choose the contact import page for vCard files.'); })())
      : (await readImportSheets(file as File)).flatMap(sheet => sheetObjects(sheet, value => value.replace(/^\uFEFF/, '').trim()));
    const converted = convertContactRows(rows, pageType, meta, form.get('import_format') === 'eventuai-contact' || /\.vcf$/i.test((file as File).name));
    csvText = objectsCsv(converted.map(row => ({ ...row, _import_columns: JSON.stringify(Object.keys(row)) })));
  }
  if (!csvText.trim()) {
    return redirect(`${BASE}/import/${encodeURIComponent(pageType)}`);
  }

  const scope = importScope(pageType);
  const rows = convertContactRows(importRows(csvText), pageType, meta, form.get('import_format') === 'eventuai-contact');
  csvText = objectsCsv(rows.map(row => ({ ...row, _import_columns: JSON.stringify(Object.keys(row)) })));
  const { entries, skippedEmpty, skippedUnknownType } = resolveImportEntries(meta, rows, pageType);
  const missingTaxonomies = missingContactTaxonomies(meta, entries);
  const targets = await matchEntries(cms, meta, entries, false);
  const rowsByNumber = new Map(entries.map(entry => [entry.rowNumber, entry.row]));
  const previewRows = previewImportRows(meta, entries, targets).map(preview => {
    const row = rowsByNumber.get(preview.rowNumber);
    const existing = targets.get(preview.rowNumber);
    return { ...preview, changes: row?._eventuai_contact === '1' && existing ? legacyContactChanges(row, existing, meta.default_language) : [] };
  });
  const newRows = previewRows.filter((row) => row.action === 'create');
  const existingRows = previewRows.filter((row) => row.action === 'update');
  const typeCount = new Set(entries.map((entry) => entry.pageType)).size;
  const importId = previewRows.length ? crypto.randomUUID() : '';
  if (importId) await importSession(env, userId, pageType, importId).stage(csvText);

  return adminView(env.VIEWS, `Confirm import ${scope.label}`, 'import', {
    pageType: scope.label,
    isConfirmImport: true,
    isAllTypes: scope.isAll,
    showTypeColumn: scope.isAll || typeCount > 1,
    action: `${BASE}/import/${encodeURIComponent(pageType)}/confirm`,
    backHref: scope.backHref,
    importId,
    newRows,
    existingRows,
    hasPreviewRows: previewRows.length > 0,
    hasNewRows: newRows.length > 0,
    hasExistingRows: existingRows.length > 0,
    previewCount: previewRows.length,
    newCount: newRows.length,
    existingCount: existingRows.length,
    skippedCount: skippedEmpty + skippedUnknownType,
    skippedUnknownType,
    missingTaxonomies,
    hasMissingTaxonomies: missingTaxonomies.length > 0,
    importModeOptions: csvImportModeOptions(),
    hasImportModeOptions: true,
  });
}

async function lookupTargets(cms: CmsClient, pageType: string, entries: CsvRowEntry[], includeTags: boolean): Promise<CmsPage[]> {
  const ids: number[] = [];
  const slugs: string[] = [];
  for (const { row } of entries) {
    const id = importRowId(row);
    if (id !== null) ids.push(id);
    const slug = row.slug?.trim();
    if (slug) slugs.push(slug);
  }
  if (!ids.length && !slugs.length) return [];
  return cms.lookup(pageType, [...new Set(ids)], [...new Set(slugs)], { includeTags });
}

async function importConfirm(env: AdminEnv, request: Request, pageType: string, userId: string): Promise<Response> {
  const form = await request.formData();
  const importId = form.get('import_id');
  if (typeof importId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(importId)) {
    return importSessionErrorView(env.VIEWS, 'expired');
  }
  return importSession(env, userId, pageType, importId).confirm({
    CMS_URL: env.CMS_URL,
    PLUGIN_SECRET: env.PLUGIN_SECRET,
    userId,
    pageType,
    importId,
    offset: Number(form.get('offset') ?? 0),
    mode: csvImportMode(String(form.get('action') ?? '')),
  });
}

export interface ImportProgress {
  offset: number;
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  autoImport: boolean;
}

export async function applyImportPass(
  cms: CmsClient, pageType: string, csvText: string, mode: CsvImportMode,
  progress: ImportProgress | undefined, beforeWrite: () => Promise<void>,
): Promise<ImportProgress> {
  const deadline = Date.now() + CONFIRM_WORK_MS;
  const offset = progress?.offset ?? 0;
  let meta = await cms.meta('all');
  const rows = convertContactRows(importRows(csvText), pageType, meta);
  let writes = 0;

  // `offset` counts importable entries already applied by earlier passes;
  // skipped-row counts are folded in once, on the first pass.
  const { entries, skippedEmpty, skippedUnknownType } = resolveImportEntries(meta, rows, pageType);
  const passEnd = offset + CONFIRM_ROW_LIMIT;
  const pass = entries.slice(offset, passEnd);
  // Validate legacy identities across the remaining file before writing this pass.
  const targets = mode === 'force-new' ? new Map<number, CmsPage>() : await matchEntries(cms, meta, [
    ...pass,
    ...entries.slice(passEnd).filter(isLegacyContactEntry),
  ], true);
  const result = { created: progress?.created ?? 0, updated: progress?.updated ?? 0, skipped: progress?.skipped ?? 0 };
  if (offset === 0) result.skipped += skippedEmpty + skippedUnknownType;

  const applying = pass.filter(({ rowNumber }) => targets.has(rowNumber)
    ? mode !== 'new'
    : mode !== 'append' && mode !== 'overwrite');
  const missingTaxonomies = missingContactTaxonomies(meta, applying);
  if (missingTaxonomies.length) {
    const taxonomies = await cms.ensureContactTaxonomies(missingTaxonomies);
    meta = { ...meta, taxonomies: [...meta.taxonomies, ...taxonomies] };
    writes += Math.ceil(missingTaxonomies.length / ENSURE_TAXONOMIES_CHUNK);
  }

  // Taxonomy and tag provisioning are repeatable. Mark the pass as writing
  // only when a contact or other page is about to change.
  const tagEntries = new Map<string, { taxonomy: string; name: string }>();
  for (const { row } of applying) {
    for (const entry of rowTagEntries(meta, row)) {
      tagEntries.set(tagKey(entry.taxonomy, entry.name), { taxonomy: entry.taxonomy, name: entry.name });
    }
  }
  writes += Math.ceil(tagEntries.size / ENSURE_TAGS_CHUNK);
  const ensuredTags = await cms.ensureTags([...tagEntries.values()]);

  const csvHeaders = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const specsByType = new Map<string, ReturnType<typeof csvPathSpecs>>();
  const pathSpecsFor = (type: string) => {
    let specs = specsByType.get(type);
    if (!specs) {
      specs = csvImportPathSpecs(meta, [type], csvHeaders, true);
      specsByType.set(type, specs);
    }
    return specs;
  };

  const pendingCreates: PreparedCreate[] = [];
  let processed = 0;

  const flushCreates = async () => {
    if (!pendingCreates.length) return;
    await beforeWrite();
    const outcome = await cms.batchCreate(pendingCreates);
    writes++;
    result.created += outcome.created.length;
    result.skipped += outcome.errors.length;
    pendingCreates.length = 0;
  };

  for (const [index, entry] of pass.entries()) {
    // Reserve one write for the final create flush and always make progress.
    if (processed > 0 && (writes >= WRITE_BUDGET - 1 || Date.now() >= deadline)) break;
    const { row, pageType: rowType } = entry;
    const pathSpecs = pathSpecsFor(rowType);

    const existing = targets.get(entry.rowNumber) ?? null;
    if (!existing) {
      if (mode === 'append' || mode === 'overwrite') {
        result.skipped++;
      } else {
        pendingCreates.push(prepareCreateFromRow(meta, rowType, row, pathSpecs, ensuredTags));
        if (pendingCreates.length >= CREATE_BATCH_SIZE) await flushCreates();
      }
      processed = index + 1;
      continue;
    }

    if (mode === 'new') {
      result.skipped++;
      processed = index + 1;
      continue;
    }

    const updateMode = mode === 'append' || mode === 'new-append' ? 'append' : 'replace';
    const update = prepareUpdateFromRow(meta, rowType, row, existing, pathSpecs, updateMode, ensuredTags);
    if (!update.changed) {
      result.skipped++;
    } else {
      await beforeWrite();
      await cms.update(update.id, update.input);
      writes++;
      result.updated++;
    }
    processed = index + 1;
  }

  await flushCreates();

  return {
    ...result,
    offset: offset + processed,
    totalRows: entries.length,
    autoImport: pageType === 'contact' && entries.every(entry => entry.pageType === 'contact'),
  };
}

export function importProgressView(views: Fetcher, pageType: string, importId: string, progress: ImportProgress): Promise<Response> | Response {
  const scope = importScope(pageType);
  if (progress.offset < progress.totalRows) {
    return adminView(views, `Importing ${scope.label}…`, 'import-progress', {
      ...progress,
      pageType: scope.label,
      action: `${BASE}/import/${encodeURIComponent(pageType)}/confirm`,
      backHref: scope.backHref,
      importId,
    });
  }

  const flash = `${progress.created} created, ${progress.updated} updated, ${progress.skipped} skipped`;
  return redirect(`${scope.backHref}?flash=${encodeURIComponent(flash)}`);
}

export type { ContentMeta, CsvImportMode };

function importRows(csv: string): Array<Record<string, string>> {
  return csvRowsToObjects(parseCsv(csv)).map(row => {
    if (!row._import_columns) return row;
    let columns: unknown;
    try { columns = JSON.parse(row._import_columns); } catch { throw new ImportValidationError('Invalid import column metadata.'); }
    if (!Array.isArray(columns) || !columns.every(key => typeof key === 'string')) throw new ImportValidationError('Invalid import column metadata.');
    return Object.fromEntries((columns as string[]).filter(key => key !== '_import_columns' && key in row).map(key => [key, row[key]]));
  });
}
function convertContactRows(rows: Array<Record<string, string>>, fallback: string, meta: ContentMeta, force = false): Array<Record<string, string>> {
  return rows.map(row => {
    const type = row.page_type?.trim() || fallback;
    if (type === 'contact' && row._eventuai_contact !== '1' && (force || isLegacyContactRow(row))) {
      return legacyContactRow(row, meta.default_language);
    }
    return row;
  });
}

function missingContactTaxonomies(meta: ContentMeta, entries: CsvRowEntry[]): string[] {
  const existing = new Set(meta.taxonomies.map(({ name }) => name));
  const missing = new Set<string>();
  for (const { row, pageType } of entries) {
    if (pageType !== 'contact') continue;
    for (const [column, value] of Object.entries(row)) {
      if (!column.startsWith('tag:') || !value.split(';').some(tag => tag.trim())) continue;
      const name = column.slice(4);
      if (!name || name !== name.trim()) throw new ImportValidationError(`Use a taxonomy name immediately after “tag:” in the “${column}” column.`);
      if (!existing.has(name)) missing.add(name);
    }
  }
  return [...missing];
}
