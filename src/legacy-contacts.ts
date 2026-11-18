import { legacyHeader, ImportValidationError } from './import-upload';
import type { CmsPage, ContentMeta } from './cms';
import type { CsvRowEntry } from './csv';

type Row = Record<string, string>;
/** Convert Eventuai columns to native lect paths; explicit item indices preserve empty slots. */
export function legacyContactRow(input: Row, language: string): Row {
  const raw = Object.fromEntries(Object.entries(input).map(([key, value]) => [legacyHeader(key), value]));
  if (raw.page_type && raw.page_type !== 'contact') throw new ImportValidationError('Legacy contact files can only contain contact rows.');
  const row: Row = { page_type: 'contact', _eventuai_contact: '1' };
  const consumed = new Set<string>(['page_type']);
  const move = (source: string, target: string) => { if (source in raw) { row[target] = raw[source]; consumed.add(source); } };
  move('id', 'id'); move('contact_id', 'id');
  if (raw.id && raw.contact_id && raw.id !== raw.contact_id) throw new ImportValidationError('The contact_id and id columns disagree.');
  move('no', 'slug'); move('no', 'legacy_import.no');
  for (const key of ['source', 'prefix', 'suffix', 'gender', 'nationality', 'birthday', 'referral_by', 'optout_mobile', 'optout_email', 'primary_email']) move(key, key);
  for (const [source, target] of Object.entries({ date_updated: 'updated_at', countryregion: 'region', language: 'prefer_language', remarks_contact: 'remarks' })) move(source, target);
  for (const key of ['first_name', 'middle_name', 'last_name', 'full_name', 'family_business']) move(key, `${key}.${language}`);
  if (!raw.first_name) {
    const first = raw.chinese_name_tc || raw.chinese_name_sc || (!raw.last_name ? raw.full_name || raw.name : '');
    if (first) row[`first_name.${language}`] = first;
  }
  move('bio_background', `bio.${language}`); move('chinese_name_tc', 'first_name.zh-hant'); move('chinese_name_sc', 'first_name.zh-hans');
  move('nickname', 'nickname[0].name');
  move('spouses_name', `spouse[0].name.${language}`); move('mobile_spouse', 'spouse[0].phone'); move('email_spouse', 'spouse[0].email');
  move('other_address', `other_address[0].address.${language}`);
  const position: Record<string, string> = { company: 'organization_name', client: 'client', title: 'title', department: 'department', website: 'website', email_work: 'email', email_general: 'general_email', work_phone_direct: 'direct_phone', work_phone_general: 'general_phone', work_phone_ext: 'direct_phone_ext', fax: 'fax', business_address: 'address' };
  for (let i = 1; i <= 5; i++) {
    for (const [source, target] of Object.entries(position)) {
      const localized = ['organization_name', 'client', 'title', 'department', 'address'].includes(target);
      const path = `position[${i - 1}].${target}${localized ? `.${language}` : ''}`;
      move(`${source}_${i}`, path);
      // Legacy phone exports put the index in the middle.
      if (source.startsWith('work_phone_')) move(`work_phone_${i}_${source.slice(11)}`, path);
    }
    move(`mobile_${i}`, `phone[${i - 1}].phone`);
    if (`mobile_${i}` in raw) row[`phone[${i - 1}].type`] = 'mobile';
    move(`email_personal_${i}`, `email[${i - 1}].email`);
    if (`email_personal_${i}` in raw) row[`email[${i - 1}].type`] = 'personal';
    for (const key of ['name', 'mobile', 'work_phone', 'email']) move(`assistants_${i}_${key}`, `assistant[${i - 1}].${key}${key === 'name' ? `.${language}` : ''}`);
    if (i <= 2) { move(`home_phone_${i}`, `home[${i - 1}].phone`); move(`home_address_${i}`, `home[${i - 1}].address.${language}`); }
  }
  ['instagram', 'facebook', 'twitter', 'linkedin', 'weibo', 'wechat', 'red', 'line'].forEach((platform, i) => {
    move(platform, `social_media[${i}].url`);
    if (platform in raw) row[`social_media[${i}].type`] = platform;
  });
  for (const [source, target] of Object.entries({ event_name: 'event_name', group_rsvp: 'group_rsvp', group_remark: 'remark', event_role: 'role', session_participation: 'session', rsvp_accepted_and_attended_accepted_but_unattended_declined_unconfirmed_no_response: 'rsvp' })) move(source, `event_history[0].${target}`);
  const taxonomies: Record<string, string> = { contact_type: 'Contact Type', industry: 'Industry', interest: 'Interest', food_allergies: 'Food Allergies', email_status: 'Email Status', event: 'Event' };
  for (const [source, taxonomy] of Object.entries(taxonomies)) {
    const keys = Object.keys(raw).filter(key => key === source || new RegExp(`^${source}(?:_\\d+|_seperate_by_\\d+|_preferences_\\d+)$`).test(key));
    if (keys.length) { row[`tag:${taxonomy}`] = keys.map(key => raw[key]).filter(Boolean).join('; '); keys.forEach(key => consumed.add(key)); }
  }
  // Unknown columns are retained under an explicit namespace rather than silently discarded.
  for (const [key, value] of Object.entries(raw)) if (!consumed.has(key)) row[`legacy_import.${key}`] = value;
  row.name = [raw.first_name || raw.chinese_name_tc || raw.chinese_name_sc, raw.middle_name, raw.last_name].filter(Boolean).join(' ').trim() || raw.full_name || raw.name || '';
  if (!row.name && !row.id && !row.slug) throw new ImportValidationError('A legacy contact row needs a name, contact ID, or contact number.');
  return row;
}
export function isLegacyContactRow(row: Row): boolean {
  return Object.keys(row).some(key => /^(contact_id|no|bio_background|countryregion|chinese_name_(?:tc|sc)|email_(work|personal)_\d+|company_\d+|assistants_\d+_name)$/.test(legacyHeader(key)));
}
function localized(lect: Record<string, unknown>, field: string, language: string): string {
  const value = lect[field];
  return String(value && typeof value === 'object' ? (value as Row)[language] ?? Object.values(value)[0] ?? '' : value ?? '').trim();
}
/** Legacy source/name matching supplements explicit IDs/slugs only for converted contact rows. */
export function matchLegacyContacts(entries: CsvRowEntry[], existing: CmsPage[], meta: ContentMeta): Map<number, CmsPage> {
  const byId = new Map<string, CmsPage[]>(); const bySlug = new Map<string, CmsPage[]>(); const byName = new Map<string, CmsPage[]>();
  for (const page of existing) {
    const identity = `${String(page.lect?.source || '').trim()}\u0000${localized(page.lect || {}, 'first_name', meta.default_language)}`;
    for (const [index, key] of [[byId, String(page.id)], [bySlug, page.slug], [byName, identity]] as Array<[Map<string, CmsPage[]>, string]>) {
      if (key) index.set(key, [...(index.get(key) || []), page]);
    }
  }
  const result = new Map<number, CmsPage>(); const used = new Set<number>(); const seen = new Set<string>();
  for (const { row, rowNumber } of entries) {
    const id = row.id?.trim(); const slug = row.slug?.trim();
    const first = row[`first_name.${meta.default_language}`] || row['first_name.zh-hant'] || row['first_name.zh-hans'] || '';
    const middle = row[`middle_name.${meta.default_language}`] || ''; const last = row[`last_name.${meta.default_language}`] || '';
    const source = (row.source || '').trim();
    const key = id ? `id:${id}` : slug ? `slug:${slug}` : `${source}\u0000${first}\u0000${middle}\u0000${last}`;
    if (seen.has(key)) throw new ImportValidationError(`Contact row ${rowNumber} repeats an identity in this import. Resolve duplicate/conflicting rows first.`);
    seen.add(key);
    const idMatches = id ? byId.get(id) || [] : [];
    const slugMatches = slug ? bySlug.get(slug) || [] : [];
    if (idMatches.length && slugMatches.length && idMatches[0].id !== slugMatches[0].id) throw new ImportValidationError(`Contact row ${rowNumber} has conflicting ID and contact number.`);
    let matches = idMatches.length ? idMatches : slugMatches;
    if (!matches.length && (first || last)) {
      matches = (byName.get(`${source}\u0000${first.trim()}`) || []).filter(page => {
        const lect = page.lect || {};
        return String(lect.source || '').trim() === source && localized(lect, 'first_name', meta.default_language) === first.trim()
          && (!middle || localized(lect, 'middle_name', meta.default_language) === middle.trim())
          && (!last || localized(lect, 'last_name', meta.default_language) === last.trim());
      });
      const bio = row[`bio.${meta.default_language}`];
      if (matches.length > 1 && bio) matches = matches.filter(page => localized(page.lect || {}, 'bio', meta.default_language) === bio.trim());
    }
    if (matches.length > 1) throw new ImportValidationError(`Contact row ${rowNumber} matches multiple contacts. Supply an explicit contact_id.`);
    if (matches[0]) {
      if (used.has(matches[0].id)) throw new ImportValidationError(`Multiple rows target contact ${matches[0].id}.`);
      used.add(matches[0].id); result.set(rowNumber, matches[0]);
    }
  }
  return result;
}

export function legacyContactChanges(row: Row, existing: CmsPage, language: string): Array<{ label: string; before: string; after: string; conflict: boolean }> {
  const changes: Array<{ label: string; before: string; after: string; conflict: boolean }> = [];
  for (const [path, after] of Object.entries(row)) {
    if (['id', 'page_type', '_eventuai_contact', '_import_columns'].includes(path) || path.startsWith('tag:')) continue;
    let value: unknown = path === 'name' || path === 'slug' ? existing[path] : existing.lect;
    if (path !== 'name' && path !== 'slug') {
      for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    }
    const before = String(value ?? '');
    if (before === after) continue;
    const label = path.replace(new RegExp(`\\.${language}$`), '').replace(/\[(\d+)\]/g, (_match, index: string) => ` ${Number(index) + 1}`).replace(/[._]/g, ' ');
    changes.push({ label, before, after, conflict: before.trim() !== '' });
  }
  return changes;
}
