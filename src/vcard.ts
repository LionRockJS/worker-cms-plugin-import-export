import { ImportValidationError } from './import-upload';
const decode = (value: string) => value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
/** Common UTF-8 vCard 3/4 fields, mapped through the same Eventuai contact adapter. */
export function vcardRows(text: string): Array<Record<string, string>> {
  if (/ENCODING=(?:QUOTED-PRINTABLE|BASE64|B)(?:[;:]|$)/im.test(text)) throw new ImportValidationError('Convert this encoded vCard to UTF-8 vCard 3/4 before importing.');
  const rows: Array<Record<string, string>> = []; let row: Record<string, string> | null = null; let counts: Record<string, number> = {};
  const add = (key: string, value: string) => { const i = (counts[key] || 0) + 1; counts[key] = i; row![`${key}_${i}`] = value; };
  for (const line of text.replace(/^\uFEFF/, '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    if (line.trim().toUpperCase() === 'BEGIN:VCARD') { if (row) throw new ImportValidationError('Nested vCards are not supported.'); row = {}; counts = {}; continue; }
    if (line.trim().toUpperCase() === 'END:VCARD') { if (!row) throw new ImportValidationError('Malformed vCard.'); if (Object.keys(row).length) rows.push(row); row = null; continue; }
    if (!row || !line.includes(':')) continue;
    const colon = line.indexOf(':'); const header = line.slice(0, colon); const raw = line.slice(colon + 1);
    if (/ENCODING=QUOTED-PRINTABLE/i.test(header)) throw new ImportValidationError('Export vCards as UTF-8 without quoted-printable encoding before importing.');
    const [field, ...parameters] = header.toUpperCase().split(';'); const key = field.split('.').at(-1)!;
    const types = parameters.flatMap(value => value.replace(/^TYPE=/, '').split(','));
    const value = decode(raw);
    if (key === 'N') {
      const [last, first, middle, prefix, suffix] = raw.split(/(?<!\\);/).map(decode);
      Object.assign(row, { last_name: last || '', first_name: first || '', middle_name: middle || '', prefix: prefix || '', suffix: suffix || '' });
    } else if (key === 'FN') row.full_name = value;
    else if (key === 'EMAIL') add(types.includes('WORK') ? 'email_work' : 'email_personal', value.replace(/^mailto:/i, ''));
    else if (key === 'TEL') {
      const phone = value.replace(/^tel:/i, '');
      if (types.includes('HOME')) add('home_phone', phone);
      else if (types.includes('WORK')) { const i = (counts.work_phone || 0) + 1; counts.work_phone = i; row[`work_phone_${i}_direct`] = phone; }
      else add('mobile', phone);
    } else if (key === 'ORG') add('company', raw.split(/(?<!\\);/).map(decode).filter(Boolean).join(' / '));
    else if (key === 'TITLE') add('title', value);
    else if (key === 'ADR') add(types.includes('HOME') ? 'home_address' : 'business_address', raw.split(/(?<!\\);/).map(decode).filter(Boolean).join(', '));
    else if (key === 'NOTE') row.bio_background = value;
    else if (key === 'BDAY') row.birthday = value;
    else if (key === 'NICKNAME') row.nickname = value;
    else if (!['VERSION', 'PRODID', 'REV'].includes(key)) row[`vcf_${key.toLowerCase()}`] = value;
  }
  if (row) throw new ImportValidationError('The vCard file is missing END:VCARD.');
  if (!rows.length) throw new ImportValidationError('No contacts were found in this vCard file.');
  for (const row of rows) if (!row.first_name && row.full_name) row.first_name = row.full_name;
  return rows;
}
