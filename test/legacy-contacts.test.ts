import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { utils, write } from 'xlsx';
import worker, { importSessions } from './worker';
import { legacyContactRow, matchLegacyContacts } from '../src/legacy-contacts';
import { vcardRows } from '../src/vcard';
import { csvImportPathSpecs, prepareCreateFromRow, prepareUpdateFromRow, setLectPathValue, type Lect } from '../src/csv';
import type { ContentMeta, CmsPage } from '../src/cms';

const meta: ContentMeta = { page_types: ['contact', 'default'], languages: ['en', 'zh-hant', 'zh-hans'], default_language: 'en', path_specs: { contact: [{ path: 'first_name', kind: 'localized' }, { path: 'last_name', kind: 'localized' }, { path: 'source', kind: 'scalar' }], default: [] }, taxonomies: [{ name: 'Contact Type', slug: 'contact-type' }] };
function person(id = 1, lect: Lect = {}): CmsPage {
  return { id, uuid: `person-${id}`, page_type: 'contact', name: 'Ada Lovelace', slug: `person-${id}`, weight: 5, start: null, end: null, timezone: null, page_id: null, created_at: '', updated_at: '', lect, tags: [] };
}
const views = { async fetch(input: RequestInfo | URL) {
  try { return new Response(await readFile(fileURLToPath(new URL(`../views${new URL(String(input)).pathname}`, import.meta.url).href), 'utf8')); } catch { return new Response('not found', { status: 404 }); }
} } as Fetcher;
const options = { CMS_URL: 'https://cms.test', PLUGIN_SECRET: 'secret', VIEWS: views, IMPORT_SESSIONS: importSessions(views) };
function request(path: string, body: FormData | URLSearchParams) { return new Request(`https://import.test/__plugin/admin/import/contact${path}`, { method: 'POST', headers: { 'x-plugin-secret': 'secret', 'x-cms-user': '{"id":"1"}' }, body }); }
function setup(pages: CmsPage[] = []) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let id = 100;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method || 'GET';
    if (url.pathname === '/__cms/content-meta') return Response.json(meta);
    if (url.pathname === '/__cms/pages/search') return Response.json({ pages, total: pages.length, pagination: { totalPages: 1, currentPage: 1 } });
    if (url.pathname === '/__cms/pages' && method === 'GET') return Response.json({ pages, total: pages.length });
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    writes.push({ path: url.pathname, body });
    if (url.pathname === '/__cms/tags/ensure') return Response.json({ tags: (body.tags as Array<object>).map((tag, i) => ({ ...tag, id: i + 1 })) });
    if (url.pathname === '/__cms/pages/batch') {
      const created = (body.pages as Array<Partial<CmsPage>>).map(input => ({ ...person(id++), ...input })); pages.push(...created); return Response.json({ created, errors: [] });
    }
    if (method === 'PUT') {
      const page = pages.find(page => `/__cms/pages/${page.id}` === url.pathname)!;
      Object.assign(page, body); return Response.json({ page });
    }
    return new Response('not found', { status: 404 });
  }));
  return { pages, writes };
}
afterEach(() => vi.unstubAllGlobals());

describe('legacy contact mapping and matching', () => {
  it('maps localized names, numbered positions/assistants, phones, tags and preserves unknown columns', () => {
    const row = legacyContactRow({ contact_id: '1', no: '0001', first_name: 'Ada', last_name: 'Lovelace', chinese_name_tc: '愛達', source: 'Legacy', company_1: 'Company A', company_2: 'Company B', email_work_2: 'second@example.com', work_phone_2_direct: '0012345', assistants_2_name: 'Assistant', assistants_2_email: 'pa@example.com', email_personal_1: 'ada@example.com', food_allergies_preferences_1: 'Nuts', contact_type_1: 'VIP', bio_background: 'First\n\nSecond', custom_note: 'Keep me' }, 'en');
    const specs = csvImportPathSpecs(meta, ['contact'], Object.keys(row));
    const input = prepareCreateFromRow(meta, 'contact', row, specs, new Map([['contact-type VIP', 1]]));
    expect(input).toMatchObject({ name: 'Ada Lovelace', slug: '0001', lect: { first_name: { en: 'Ada', 'zh-hant': '愛達' }, bio: { en: 'First\n\nSecond' }, position: [{ organization_name: { en: 'Company A' } }, { organization_name: { en: 'Company B' }, email: 'second@example.com', direct_phone: '0012345' }], assistant: [undefined, { name: { en: 'Assistant' }, email: 'pa@example.com' }], legacy_import: { custom_note: 'Keep me' } }, tags: [1] });
    expect(input.lect).not.toHaveProperty('_eventuai_contact');
  });
  it('keeps indexed item slots and unmentioned fields in append and replace modes', () => {
    const existing = person(1, { first_name: { en: 'Ada' }, position: [{ title: { en: 'Original' }, email: 'old@example.com' }, { title: { en: 'Keep second' } }], response: [{ note: 'Keep history' }] });
    const row = legacyContactRow({ contact_id: '1', first_name: 'Ada', title_1: 'Incoming', email_work_2: 'new@example.com' }, 'en');
    const specs = csvImportPathSpecs(meta, ['contact'], Object.keys(row));
    const append = prepareUpdateFromRow(meta, 'contact', row, existing, specs, 'append', new Map());
    expect(append.input.lect).toMatchObject({ position: [{ title: { en: 'Original' }, email: 'old@example.com' }, { title: { en: 'Keep second' }, email: 'new@example.com' }], response: [{ note: 'Keep history' }] });
    const replace = prepareUpdateFromRow(meta, 'contact', row, existing, specs, 'replace', new Map());
    expect(replace.input.lect).toMatchObject({ position: [{ title: { en: 'Incoming' }, email: 'old@example.com' }, { title: { en: 'Keep second' }, email: 'new@example.com' }] });
    expect(() => setLectPathValue({}, 'position[0].__proto__.polluted', 'scalar', 'yes', 'en')).toThrow(/Unsafe/);
  });
  it('matches exact source/name, rejects ambiguity, contradictory identifiers and duplicate file identities', () => {
    const row = legacyContactRow({ first_name: 'Ada', last_name: 'Lovelace', source: 'A' }, 'en');
    const a = person(1, { first_name: { en: 'Ada' }, last_name: { en: 'Lovelace' }, source: 'A' });
    const b = person(2, { ...a.lect, source: 'B' });
    expect(matchLegacyContacts([{ rowNumber: 2, pageType: 'contact', row }], [a, b], meta).get(2)?.id).toBe(1);
    expect(() => matchLegacyContacts([{ rowNumber: 2, pageType: 'contact', row }], [a, { ...a, id: 3 }], meta)).toThrow(/multiple contacts/);
    expect(() => matchLegacyContacts([{ rowNumber: 2, pageType: 'contact', row: { ...row, id: '2', slug: a.slug } }], [a, b], meta)).toThrow(/conflicting/);
    expect(() => matchLegacyContacts([{ rowNumber: 2, pageType: 'contact', row }, { rowNumber: 3, pageType: 'contact', row }], [a], meta)).toThrow(/repeats/);
  });
  it('reads folded/escaped vCard data and multiple personal/work addresses', () => {
    const rows = vcardRows('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada Lovelace\r\nN:Lovelace;Ada;;;\r\nEMAIL;TYPE=WORK:work@example.com\r\nEMAIL;TYPE=HOME:personal@example.com\r\nNOTE:First\\n\r\n Second\\, part\r\nEND:VCARD\r\n');
    expect(rows[0]).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace', email_work_1: 'work@example.com', email_personal_1: 'personal@example.com', bio_background: 'First\nSecond, part' });
    expect(() => vcardRows('BEGIN:VCARD\nFN:Missing end')).toThrow(/END:VCARD/);
  });
});

describe('legacy contact upload workflow', () => {
  it('reimports migrated contacts when the legacy ID no longer resolves', async () => {
    const f = setup();
    const csv = 'contact_id,first_name,last_name,source,email_work_1\n999,Ada,Lovelace,Legacy,ada@example.com\n';
    const run = async () => {
      const review = await worker.fetch(request('', new URLSearchParams({ csv })), options);
      const { importId } = await review.json() as { importId: string };
      return worker.fetch(request('/confirm', new URLSearchParams({ import_id: importId, action: 'new-append' })), options);
    };
    expect((await run()).status).toBe(302);
    expect(f.pages).toHaveLength(1);
    expect(f.pages[0].id).not.toBe(999);
    const count = f.writes.length;
    expect((await run()).status).toBe(302);
    expect(f.pages).toHaveLength(1); expect(f.writes).toHaveLength(count);
  });
  it('previews a workbook without writes, then fills missing fields and re-imports without duplicates', async () => {
    const existing = person(1, { first_name: { en: 'Ada' }, last_name: { en: 'Lovelace' }, source: 'Legacy', position: [{ title: { en: 'Keep title' } }] });
    const f = setup([existing]);
    const wb = utils.book_new(); utils.book_append_sheet(wb, utils.aoa_to_sheet([['First Name', 'Last Name', 'Source', 'email_work_2'], ['Ada', 'Lovelace', 'Legacy', 'second@example.com']]), 'Contacts');
    const form = new FormData(); form.set('file', new File([write(wb, { type: 'array', bookType: 'xlsx' })], 'contacts.xlsx'));
    const preview = await worker.fetch(request('', form), options);
    const data = await preview.json() as { importId: string; existingCount: number };
    expect(data.existingCount).toBe(1); expect(f.writes).toHaveLength(0);
    const run = () => worker.fetch(request('/confirm', new URLSearchParams({ import_id: data.importId, action: 'new-append' })), options);
    expect((await run()).status).toBe(302);
    expect(f.pages).toHaveLength(1); expect(existing.lect).toMatchObject({ position: [{ title: { en: 'Keep title' } }, { email: 'second@example.com' }] });
    const count = f.writes.length; expect((await run()).status).toBe(302); expect(f.writes).toHaveLength(count);
  });
  it('supports vCard uploads through the same preview and confirmation flow', async () => {
    const f = setup(); const form = new FormData(); form.set('file', new File(['BEGIN:VCARD\nVERSION:3.0\nN:Hopper;Grace;;;\nEMAIL:grace@example.com\nEND:VCARD'], 'contacts.vcf'));
    const response = await worker.fetch(request('', form), options); const data = await response.json() as { importId: string };
    expect((await worker.fetch(request('/confirm', new URLSearchParams({ import_id: data.importId })), options)).status).toBe(302);
    expect(f.pages[0]).toMatchObject({ name: 'Grace Hopper', lect: { email: [{ email: 'grace@example.com' }] } });
  });
  it.each(['new', 'append', 'new-append', 'overwrite', 'new-overwrite', 'force-new'])('preserves existing mode semantics for legacy rows: %s', async mode => {
    const f = setup([person(1, { first_name: { en: 'Ada' }, last_name: { en: 'Lovelace' }, source: 'A', position: [{ email: 'keep@example.com' }] })]);
    const csv = 'first_name,last_name,source,email_work_1\nAda,Lovelace,A,replace@example.com\nGrace,Hopper,A,grace@example.com\n';
    const preview = await worker.fetch(request('', new URLSearchParams({ csv })), options); const data = await preview.json() as { importId: string };
    const response = await worker.fetch(request('/confirm', new URLSearchParams({ import_id: data.importId, action: mode })), options);
    expect(response.status).toBe(302);
    expect(f.pages).toHaveLength(mode === 'force-new' ? 3 : ['append', 'overwrite'].includes(mode) ? 1 : 2);
    expect((f.pages[0].lect.position as Array<{ email: string }>)[0].email).toBe(['overwrite', 'new-overwrite'].includes(mode) ? 'replace@example.com' : 'keep@example.com');
  });
  it('fails validation before tag creation or writes for ambiguous contacts', async () => {
    const a = person(1, { first_name: { en: 'Ada' }, last_name: { en: 'Lovelace' }, source: 'A' });
    const f = setup([a, { ...a, id: 2 }]);
    const response = await worker.fetch(request('', new URLSearchParams({ csv: 'first_name,last_name,source,email_work_1,contact_type\nAda,Lovelace,A,new@example.com,VIP\n' })), options);
    expect(JSON.stringify(await response.json())).toContain('multiple contacts'); expect(f.writes).toHaveLength(0);
  });
});

it('keeps sheet-specific absent columns distinct from explicit blanks during replacement', async () => {
  const f = setup([person(1, { first_name: { en: 'Ada' }, last_name: { en: 'Lovelace' }, position: [{ title: { en: 'Preserve title' }, email: 'clear@example.com' }] }), { ...person(2, { first_name: { en: 'Grace' }, last_name: { en: 'Hopper' }, position: [{ email: 'preserve@example.com' }] }), name: 'Grace Hopper' }]);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet([['contact_id', 'first_name', 'last_name', 'email_work_1'], ['1', 'Ada', 'Lovelace', '']]), 'Ada');
  utils.book_append_sheet(wb, utils.aoa_to_sheet([['contact_id', 'first_name', 'last_name', 'title_1'], ['2', 'Grace', 'Hopper', 'Admiral']]), 'Grace');
  const form = new FormData(); form.set('file', new File([write(wb, { type: 'array', bookType: 'xlsx' })], 'contacts.xlsx'));
  const preview = await worker.fetch(request('', form), options); const data = await preview.json() as { importId: string };
  expect((await worker.fetch(request('/confirm', new URLSearchParams({ import_id: data.importId, action: 'overwrite' })), options)).status).toBe(302);
  expect(f.pages[0].lect).toMatchObject({ position: [{ email: '', title: { en: 'Preserve title' } }] });
  expect(f.pages[1].lect).toMatchObject({ position: [{ email: 'preserve@example.com', title: { en: 'Admiral' } }] });
});

it('continues a large legacy contact update without reapplying earlier rows', async () => {
  const f = setup(Array.from({ length: 45 }, (_, i) => person(i + 1, { first_name: { en: 'Ada' }, last_name: { en: 'Lovelace' }, position: [{}] })));
  const csv = 'contact_id,first_name,last_name,email_work_1\n' + Array.from({ length: 45 }, (_, i) => `${i + 1},Ada,Lovelace,user${i}@example.com`).join('\n');
  const review = await worker.fetch(request('', new URLSearchParams({ csv })), options);
  const { importId } = await review.json() as { importId: string };
  const response = await worker.fetch(request('/confirm', new URLSearchParams({ import_id: importId, action: 'append' })), options);
  const data = await response.json() as { importId: string; offset: number };
  expect(data.offset).toBeGreaterThan(0); expect(data.offset).toBeLessThan(45);
  const form = new URLSearchParams({ import_id: data.importId, offset: String(data.offset) });
  expect((await worker.fetch(request('/confirm', form), options)).status).toBe(302);
  expect(f.writes.filter(write => /\/pages\/\d+$/.test(write.path))).toHaveLength(45);
});

it('previews conflicting field values without writing and rejects truncated/encoded vCards', async () => {
  const f = setup([person(1, { first_name: { en: 'Ada' }, last_name: { en: 'Lovelace' }, position: [{ email: 'old@example.com' }] })]);
  const response = await worker.fetch(request('', new URLSearchParams({ csv: 'contact_id,first_name,last_name,email_work_1\n1,Ada,Lovelace,new@example.com\n' })), options);
  const data = await response.json() as { existingRows: Array<{ changes: Array<{ before: string; after: string; conflict: boolean }> }> };
  expect(data.existingRows[0].changes).toContainEqual(expect.objectContaining({ before: 'old@example.com', after: 'new@example.com', conflict: true }));
  expect(f.writes).toHaveLength(0);
  expect(() => vcardRows('BEGIN:VCARD\nFN:Ada')).toThrow(/END:VCARD/);
  expect(() => vcardRows('BEGIN:VCARD\nFN;ENCODING=QUOTED-PRINTABLE:=41da\nEND:VCARD')).toThrow(/UTF-8/);
});
