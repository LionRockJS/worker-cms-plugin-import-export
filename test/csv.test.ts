import { describe, expect, it } from 'vitest';
import {
  ALL_PAGE_TYPES,
  blockTypesForLect,
  buildContentTypeSetupExport,
  buildExportCsv,
  csvFormatValue,
  csvImportPathSpecs,
  csvImportMode,
  csvPathSpecs,
  csvRowsToObjects,
  groupEntriesByType,
  matchImportTargets,
  parseContentTypeSetupImport,
  parseCsv,
  prepareCreateFromRow,
  prepareUpdateFromRow,
  previewImportRows,
  resolveImportEntries,
} from '../src/csv';
import type { CmsPage, ContentMeta } from '../src/cms';

const meta: ContentMeta = {
  page_types: ['default'],
  languages: ['en', 'zh-hant'],
  default_language: 'en',
  taxonomies: [{ name: 'Topic', slug: 'topic' }],
  path_specs: {
    default: [
      { path: 'name', kind: 'localized' },
      { path: 'summary', kind: 'localized' },
      { path: 'status', kind: 'scalar' },
      { path: '_pointers.parent', kind: 'pointer' },
    ],
  },
};

function page(overrides: Partial<CmsPage>): CmsPage {
  return {
    id: 1,
    uuid: 'u-1',
    page_type: 'default',
    name: 'One',
    slug: 'one',
    weight: 5,
    start: null,
    end: null,
    timezone: null,
    page_id: null,
    created_at: '',
    updated_at: '',
    lect: {},
    ...overrides,
  } as CmsPage;
}

describe('CSV parsing and formatting (ported from the host)', () => {
  it('parses quoted CSV and drops fully empty rows', () => {
    const rows = parseCsv('name,note\n"Hello, World","line1\nline2"\n,\n"Quote ""x"""');
    expect(rows[0]).toEqual(['name', 'note']);
    expect(rows[1]).toEqual(['Hello, World', 'line1\nline2']);
    expect(rows[2]).toEqual(['Quote "x"']);
  });

  it('round-trips Excel string literals used to protect numeric CSV cells', () => {
    expect(parseCsv('id,weight\n="0007",="3"')).toEqual([
      ['id', 'weight'],
      ['0007', '3'],
    ]);
  });

  it('maps rows to objects keyed by header', () => {
    expect(csvRowsToObjects([['name', 'slug'], ['About', 'about']])).toEqual([{ name: 'About', slug: 'about' }]);
  });

  it('formats CSV cells, escaping and protecting numeric strings', () => {
    expect(csvFormatValue(null)).toBe('');
    expect(csvFormatValue('plain')).toBe('plain');
    expect(csvFormatValue('a,b')).toBe('"a,b"');
    expect(csvFormatValue('say "hi"')).toBe('"say ""hi"""');
    expect(csvFormatValue('0123')).toBe('="0123"');
  });

  it('neutralizes CSV/formula-injection payloads', () => {
    expect(csvFormatValue('=1+1')).toBe("'=1+1");
    expect(csvFormatValue('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvFormatValue('+cmd')).toBe("'+cmd");
    expect(csvFormatValue('-cmd|calc')).toBe("'-cmd|calc");
    expect(csvFormatValue('=a,b')).toBe('"\'=a,b"');
    expect(csvFormatValue('-5')).toBe('="-5"');
    expect(csvFormatValue('+1')).toBe('="+1"');
  });

  it('resolves the CSV import mode, defaulting safely', () => {
    expect(csvImportMode('overwrite')).toBe('overwrite');
    expect(csvImportMode('force-new')).toBe('force-new');
    expect(csvImportMode('bogus')).toBe('new-append');
  });
});

describe('path specs', () => {
  it('expands localized blueprint paths per language', () => {
    const specs = csvPathSpecs(meta, ['default']);
    expect(specs.map((spec) => spec.header)).toEqual([
      'name.en', 'name.zh-hant',
      'summary.en', 'summary.zh-hant',
      'status',
      '_pointers.parent',
    ]);
  });

  it('adds a legacy default-language column when requested', () => {
    const specs = csvPathSpecs(meta, ['default'], true);
    expect(specs[0]).toEqual({ header: 'name', sourcePath: 'name', kind: 'localized', language: 'en' });
  });
});

describe('export', () => {
  it('builds a CSV with blueprint, data-discovered and tag columns', () => {
    const pages = [
      page({
        weight: 3,
        lect: {
          name: { en: 'One' },
          status: 'live',
          extra: 'x',
          _blocks: [{ _type: 'hero', title: { en: 'Hero' } }, { _type: 'text', body: 'Body' }],
        },
        tags: [{ id: 9, name: 'News', taxonomy: 'Topic', taxonomy_slug: 'topic' }],
      }),
    ];
    const csv = buildExportCsv(meta, pages, ['default']);
    const [headers, row] = parseCsv(csv.replace(/^﻿/, ''));
    expect(headers).toContain('status');
    expect(headers).toContain('extra');
    expect(headers).toContain('tag:Topic');
    expect(row[headers.indexOf('name.en')]).toBe('One');
    expect(row[headers.indexOf('status')]).toBe('live');
    expect(row[headers.indexOf('weight')]).toBe('3');
    expect(row[headers.indexOf('page_type')]).toBe('default');
    expect(row[headers.indexOf('block_type')]).toBe('hero; text');
    expect(row[headers.indexOf('tag:Topic')]).toBe('News');
  });

  it('lists unique structured block types and exports their observed fields for setup', () => {
    const pages = [page({
      lect: {
        _blocks: [
          { _type: 'hero', title: { en: 'Hero' } },
          { _type: 'hero', title: { en: 'Hero 2' } },
        ],
      },
    })];
    expect(blockTypesForLect(pages[0].lect as Record<string, unknown>)).toEqual(['hero']);

    const setup = buildContentTypeSetupExport({
      ...meta,
      page_type_definitions: {
        default: { blueprint: ['name'], block_types: ['hero'], taxonomy_types: ['topic'] },
      },
      block_type_definitions: {
        hero: { blueprint: ['title'] },
      },
    }, pages);
    expect(setup.page_types[0]).toMatchObject({
      page_type: 'default',
      blueprint: ['name'],
      block_types: ['hero'],
      taxonomy_types: ['topic'],
    });
    expect(setup.block_types[0]).toMatchObject({ block_type: 'hero', blueprint: ['title'] });
    expect(setup.block_types[0].path_specs).toContainEqual({ path: 'title', kind: 'localized' });
  });

  it('validates and normalizes an exported type setup for import', () => {
    const setup = buildContentTypeSetupExport({
      ...meta,
      page_type_definitions: {
        default: { blueprint: ['name'], block_types: ['hero'], taxonomy_types: ['topic'] },
      },
      block_type_definitions: {
        hero: { blueprint: ['title'] },
      },
    }, [page({ lect: { name: { en: 'One' }, _blocks: [{ _type: 'hero', title: 'Hero' }] } })]);

    const result = parseContentTypeSetupImport(JSON.stringify({ ...setup, exported_at: '2026-08-05T00:00:00.000Z' }));
    expect(result.errors).toEqual([]);
    expect(result.setup?.page_types[0]).toMatchObject({ page_type: 'default', block_types: ['hero'] });
    expect(result.setup?.block_types[0]).toMatchObject({ block_type: 'hero', blueprint: ['title'] });
  });

  it('rejects malformed type setup files before any write can happen', () => {
    const result = parseContentTypeSetupImport(JSON.stringify({
      format: '0xCMS content-type-setup',
      version: 1,
      languages: ['en'],
      default_language: 'en',
      taxonomies: [],
      page_types: [{ page_type: 'bad slug', name: 'Bad', blueprint: [], block_types: [], taxonomy_types: [] }],
      block_types: [],
    }));
    expect(result.setup).toBeNull();
    expect(result.errors.some((error) => error.includes('page_types[0].page_type'))).toBe(true);
  });
});

describe('import classify', () => {
  const entriesFor = (rows: Array<Record<string, string>>, pageType = 'default') =>
    resolveImportEntries(meta, rows, pageType).entries;

  it('matches rows to existing pages by id first, then slug', () => {
    const existing = [page({ id: 7, slug: 'seven' }), page({ id: 8, slug: 'eight' })];
    const entries = entriesFor([
      { id: '7', slug: 'eight', name: 'ByIdWins' },
      { id: '', slug: 'eight', name: 'BySlug' },
      { id: '', slug: 'nine', name: 'NoMatch' },
    ]);
    const targets = matchImportTargets(entries, existing);
    expect(targets.get(2)?.id).toBe(7);
    expect(targets.get(3)?.id).toBe(8);
    expect(targets.has(4)).toBe(false);
  });

  it('previews creates vs updates and skips empty rows', () => {
    const existing = [page({ id: 7, slug: 'seven', name: 'Seven' })];
    const rows = csvRowsToObjects(parseCsv('name,slug\nNew Page,new-page\nSeven Updated,seven\n,\n'));
    const { entries, skippedEmpty } = resolveImportEntries(meta, rows, 'default');
    const targets = matchImportTargets(entries, existing);
    const preview = previewImportRows(meta, entries, targets);
    expect(skippedEmpty).toBe(0); // parseCsv already drops fully empty lines
    expect(preview).toHaveLength(2);
    expect(preview[0]).toMatchObject({ action: 'create', name: 'New Page', slug: 'new-page', pageType: 'default' });
    expect(preview[1]).toMatchObject({ action: 'update', existingId: 7 });
  });

  it("honors each row's page_type column over the import page's type", () => {
    const mixedMeta: ContentMeta = { ...meta, page_types: ['default', 'guest'] };
    const rows: Array<Record<string, string>> = [
      { name: 'Plain', slug: 'plain' },
      { name: 'A Guest', slug: 'a-guest', page_type: 'guest' },
      { name: 'Typo', slug: 'typo', page_type: 'geust' },
    ];
    const { entries, skippedUnknownType } = resolveImportEntries(mixedMeta, rows, 'default');
    expect(entries.map((entry) => entry.pageType)).toEqual(['default', 'guest']);
    expect(skippedUnknownType).toBe(1);

    const groups = groupEntriesByType(entries);
    expect([...groups.keys()].sort()).toEqual(['default', 'guest']);
  });

  it('requires a valid page_type per row in all-types mode', () => {
    const { entries, skippedUnknownType } = resolveImportEntries(
      meta,
      [{ name: 'No Type', slug: 'no-type' }, { name: 'Typed', slug: 'typed', page_type: 'default' }],
      ALL_PAGE_TYPES,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].pageType).toBe('default');
    expect(skippedUnknownType).toBe(1);
  });
});

describe('import apply', () => {
  const specs = csvPathSpecs(meta, ['default'], true);

  it('prepares a create input with lect values and ensured tag ids', () => {
    const row = { 'name.en': 'Fresh', status: 'draft', 'tag:Topic': 'News; Blog', weight: '3' };
    const ensured = new Map([['topic News', 9], ['topic Blog', 10]]);
    const create = prepareCreateFromRow(meta, 'default', row, specs, ensured);
    expect(create.name).toBe('Fresh');
    expect(create.weight).toBe(3);
    expect(create.lect).toMatchObject({ name: { en: 'Fresh' }, status: 'draft' });
    expect(create.tags).toEqual([9, 10]);
  });

  it('round-trips explicit block types and data-only structured fields', () => {
    const row = {
      name: 'With blocks',
      slug: 'with-blocks',
      page_type: 'default',
      block_type: 'hero; text',
      '_blocks[*]._type': 'hero; text',
      '_blocks[*].title.en': 'Hero; Text',
    };
    const pathSpecs = csvImportPathSpecs(meta, ['default'], Object.keys(row), true);
    const create = prepareCreateFromRow(meta, 'default', row, pathSpecs, new Map());
    expect(create.lect._blocks).toEqual([
      { _type: 'hero', title: { en: 'Hero' } },
      { _type: 'text', title: { en: 'Text' } },
    ]);
  });

  it('append mode only fills blanks; replace mode overwrites', () => {
    const existing = page({ id: 7, slug: 'seven', name: 'Seven', lect: { status: 'live', name: { en: 'Seven' } } });
    const row = { status: 'draft', 'name.en': 'Renamed' };

    const append = prepareUpdateFromRow(meta, 'default', row, existing, specs, 'append', new Map());
    expect(append.changed).toBe(false);

    const replace = prepareUpdateFromRow(meta, 'default', row, existing, specs, 'replace', new Map());
    expect(replace.changed).toBe(true);
    expect(replace.input.lect).toMatchObject({ status: 'draft', name: { en: 'Renamed' } });
  });

  it('imports an explicit weight onto a default-weight page in append mode', () => {
    const existing = page({ id: 7, weight: 5 });
    const row = { weight: '3' };

    const update = prepareUpdateFromRow(meta, 'default', row, existing, specs, 'append', new Map());
    expect(update.changed).toBe(true);
    expect(update.input.weight).toBe(3);
  });

  it('preserves a non-default weight in append mode but accepts it in replace mode', () => {
    const existing = page({ id: 7, weight: 9 });
    const row = { weight: '3' };

    const append = prepareUpdateFromRow(meta, 'default', row, existing, specs, 'append', new Map());
    expect(append.changed).toBe(false);
    expect(append.input.weight).toBeUndefined();

    const replace = prepareUpdateFromRow(meta, 'default', row, existing, specs, 'replace', new Map());
    expect(replace.changed).toBe(true);
    expect(replace.input.weight).toBe(3);
  });

  it('does not send an invalid page weight to the CMS', () => {
    const existing = page({ id: 7, weight: 5 });
    const row = { weight: 'not-a-number' };

    const update = prepareUpdateFromRow(meta, 'default', row, existing, specs, 'replace', new Map());
    expect(update.changed).toBe(false);
    expect(update.input.weight).toBeUndefined();
  });

  it('replace mode swaps tags only in taxonomies present in the CSV', () => {
    const existing = page({
      id: 7,
      tags: [{ id: 1, name: 'Old', taxonomy: 'Topic', taxonomy_slug: 'topic' }],
    });
    const row = { 'tag:Topic': 'News' };
    const ensured = new Map([['topic News', 9]]);
    const update = prepareUpdateFromRow(meta, 'default', row, existing, specs, 'replace', ensured);
    expect(update.changed).toBe(true);
    expect(update.input.tags).toEqual([9]);
  });
});
