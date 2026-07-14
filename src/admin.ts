// ============================================================
// Admin UI — proxied by the CMS at /admin/plugins/import-export/<rest>.
//
// Routes (rest after /__plugin/admin):
//   GET  ""                          → home: per-type import/export index
//   GET  export?page_type=X          → CSV download (all pages of X; omit = every type)
//   GET  export-search?<as-query>    → CSV of an admin advanced-search result
//   GET  import/<type>               → upload form
//   POST import/<type>               → parse + classify → preview/confirm view
//   POST import/<type>/confirm       → apply (budgeted; renders a Continue view
//                                      when a pass stops early, like the events
//                                      plugin's resumable guest import)
//
// Every write pass is bounded by WRITE_BUDGET so one request can never blow
// the Worker's subrequest cap on a big CSV; confirm re-parses the raw CSV
// carried in a hidden field (small, and the server re-validates everything).
// ============================================================

import { adminView, notFoundView, parseCmsUser, redirect } from '@lionrockjs/worker-cms-plugin';
import { CmsApiError, CmsClient, CREATE_BATCH_SIZE, chunk, tagKey, type CmsPage, type ContentMeta, type SearchCriterion } from './cms';
import {
  buildExportCsv,
  csvDownloadResponse,
  csvImportMode,
  csvImportModeOptions,
  csvPathSpecs,
  csvRowHasValues,
  csvRowsToObjects,
  exportHeaders,
  importRowId,
  matchImportTargets,
  parseCsv,
  prepareCreateFromRow,
  prepareUpdateFromRow,
  previewImportRows,
  rowTagEntries,
  type CsvImportMode,
  type PreparedCreate,
} from './csv';

export interface AdminEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  VIEWS: Fetcher;
}

/** Base path of this plugin's admin UI on the CMS origin (forms/links must use it). */
const BASE = '/admin/plugins/import-export';

/** Write calls (batch create / update / tag ensure) allowed per confirm pass. */
const WRITE_BUDGET = 40;

export async function handleAdmin(request: Request, env: AdminEnv, url: URL): Promise<Response> {
  const rest = url.pathname.slice('/__plugin/admin'.length).replace(/^\/+|\/+$/g, '');
  const segments = rest.split('/').filter(Boolean);
  const user = parseCmsUser(request.headers.get('x-cms-user'));

  let cms: CmsClient;
  try {
    cms = new CmsClient(env).actAs(user.id);
  } catch {
    return adminView(env.VIEWS, 'Import / Export', 'error', {
      heading: 'Not configured',
      message: 'CMS_URL / PLUGIN_SECRET are not configured for this plugin Worker.',
    });
  }

  try {
    if (segments.length === 0) return home(cms, env);

    if (segments[0] === 'export' && request.method === 'GET') {
      return exportPages(cms, url.searchParams.get('page_type') ?? segments[1] ?? '');
    }
    if (segments[0] === 'export-search' && request.method === 'GET') {
      return exportSearch(cms, url);
    }
    if (segments[0] === 'import' && segments[1]) {
      const pageType = decodeURIComponent(segments[1]);
      if (request.method === 'GET') return importForm(cms, env, pageType);
      if (request.method === 'POST' && segments[2] === 'confirm') return importConfirm(cms, env, request, pageType);
      if (request.method === 'POST') return importPreview(cms, env, request, pageType);
    }

    return notFoundView(env.VIEWS);
  } catch (error) {
    if (error instanceof CmsApiError) {
      return adminView(env.VIEWS, 'Import / Export', 'error', {
        heading: 'CMS request failed',
        message: `The CMS responded ${error.status} (${error.code}) on ${error.method} ${error.path}. `
          + 'If this is a forbidden_page_type error, approve this plugin\'s "*" page-type access under Plugins → import-export → Page types.',
      });
    }
    throw error;
  }
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

async function importForm(cms: CmsClient, env: AdminEnv, pageType: string): Promise<Response> {
  const meta = await cms.meta([pageType]);
  return adminView(env.VIEWS, `Import ${pageType}`, 'import', {
    pageType,
    isConfirmImport: false,
    action: `${BASE}/import/${encodeURIComponent(pageType)}`,
    backHref: `/admin/pages/list/${encodeURIComponent(pageType)}`,
    sampleCsvHeader: exportHeaders(csvPathSpecs(meta, [pageType]), meta.taxonomies).join(','),
  });
}

async function importPreview(cms: CmsClient, env: AdminEnv, request: Request, pageType: string): Promise<Response> {
  const form = await request.formData();
  const file = form.get('file');
  let csvText = typeof form.get('csv') === 'string' ? String(form.get('csv')) : '';
  if (file && typeof file === 'object' && 'text' in file && (file as File).size > 0) {
    csvText = await (file as File).text();
  }
  if (!csvText.trim()) {
    return redirect(`${BASE}/import/${encodeURIComponent(pageType)}`);
  }

  const meta = await cms.meta([pageType]);
  const rows = csvRowsToObjects(parseCsv(csvText));
  const targets = matchImportTargets(rows, await lookupTargets(cms, pageType, rows));
  const preview = previewImportRows(meta, pageType, rows, targets);
  const newRows = preview.rows.filter((row) => row.action === 'create');
  const existingRows = preview.rows.filter((row) => row.action === 'update');

  return adminView(env.VIEWS, `Confirm import ${pageType}`, 'import', {
    pageType,
    isConfirmImport: true,
    action: `${BASE}/import/${encodeURIComponent(pageType)}/confirm`,
    backHref: `/admin/pages/list/${encodeURIComponent(pageType)}`,
    csvText,
    previewRows: preview.rows,
    newRows,
    existingRows,
    hasPreviewRows: preview.rows.length > 0,
    hasNewRows: newRows.length > 0,
    hasExistingRows: existingRows.length > 0,
    previewCount: preview.rows.length,
    newCount: newRows.length,
    existingCount: existingRows.length,
    skippedCount: preview.skipped,
    importModeOptions: csvImportModeOptions(),
    hasImportModeOptions: true,
  });
}

async function lookupTargets(cms: CmsClient, pageType: string, rows: Array<Record<string, string>>): Promise<CmsPage[]> {
  const ids: number[] = [];
  const slugs: string[] = [];
  for (const row of rows) {
    const id = importRowId(row);
    if (id !== null) ids.push(id);
    const slug = row.slug?.trim();
    if (slug) slugs.push(slug);
  }
  if (!ids.length && !slugs.length) return [];
  return cms.lookup(pageType, [...new Set(ids)], [...new Set(slugs)], { includeTags: true });
}

async function importConfirm(cms: CmsClient, env: AdminEnv, request: Request, pageType: string): Promise<Response> {
  const form = await request.formData();
  const csvText = typeof form.get('csv') === 'string' ? String(form.get('csv')) : '';
  const mode = csvImportMode(typeof form.get('action') === 'string' ? String(form.get('action')) : '');
  const offset = parsedCount(form.get('offset'));
  const carried = {
    created: parsedCount(form.get('created')),
    updated: parsedCount(form.get('updated')),
    skipped: parsedCount(form.get('skipped')),
  };
  if (!csvText.trim()) {
    return redirect(`${BASE}/import/${encodeURIComponent(pageType)}`);
  }

  const meta = await cms.meta([pageType]);
  const rows = csvRowsToObjects(parseCsv(csvText));
  const remaining = rows.slice(offset);
  const pathSpecs = csvPathSpecs(meta, [pageType], true);
  let writes = 0;

  // Idempotent across passes: re-ensure the tags the remaining rows mention.
  const tagEntries = new Map<string, { taxonomy: string; name: string }>();
  for (const row of remaining) {
    for (const entry of rowTagEntries(meta, row)) {
      tagEntries.set(tagKey(entry.taxonomy, entry.name), { taxonomy: entry.taxonomy, name: entry.name });
    }
  }
  const ensuredTags = tagEntries.size
    ? await (async () => { writes += Math.ceil(tagEntries.size / 200); return cms.ensureTags([...tagEntries.values()]); })()
    : new Map<string, number>();

  const targets = mode === 'force-new'
    ? new Map<number, CmsPage>()
    : matchImportTargets(remaining, await lookupTargets(cms, pageType, remaining));

  const result = { ...carried };
  const pendingCreates: PreparedCreate[] = [];
  let processed = 0;

  const flushCreates = async () => {
    for (const part of chunk(pendingCreates, CREATE_BATCH_SIZE)) {
      const outcome = await cms.batchCreate(part);
      writes++;
      result.created += outcome.created.length;
      result.skipped += outcome.errors.length;
    }
    pendingCreates.length = 0;
  };

  for (const [index, row] of remaining.entries()) {
    // Reserve one write for the final create flush.
    if (writes >= WRITE_BUDGET - 1) break;

    if (!csvRowHasValues(row)) {
      result.skipped++;
      processed = index + 1;
      continue;
    }

    const existing = targets.get(index) ?? null;
    if (!existing) {
      if (mode === 'append' || mode === 'overwrite') {
        result.skipped++;
      } else {
        pendingCreates.push(prepareCreateFromRow(meta, pageType, row, pathSpecs, ensuredTags));
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
    const update = prepareUpdateFromRow(meta, pageType, row, existing, pathSpecs, updateMode, ensuredTags);
    if (!update.changed) {
      result.skipped++;
    } else {
      await cms.update(update.id, update.input);
      writes++;
      result.updated++;
    }
    processed = index + 1;
  }

  await flushCreates();

  const nextOffset = offset + processed;
  if (nextOffset < rows.length) {
    return adminView(env.VIEWS, `Importing ${pageType}…`, 'import-progress', {
      pageType,
      action: `${BASE}/import/${encodeURIComponent(pageType)}/confirm`,
      csvText,
      mode,
      offset: nextOffset,
      totalRows: rows.length,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
    });
  }

  const flash = `${result.created} created, ${result.updated} updated, ${result.skipped} skipped`;
  return redirect(`/admin/pages/list/${encodeURIComponent(pageType)}?flash=${encodeURIComponent(flash)}`);
}

function parsedCount(value: unknown): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export type { ContentMeta, CsvImportMode };
