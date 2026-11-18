/** Request-local spreadsheet decoding. Binary workbooks are loaded lazily on import only. */
export interface ImportSheet { name: string; rows: string[][] }
export class ImportValidationError extends Error {}
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;
export function csvText(rows: string[][]): string {
  return rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\n');
}
export function parseImportCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let value = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && char === ',') { row.push(value); value = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(value); if (row.some(cell => cell.trim())) rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (quoted) throw new ImportValidationError('The CSV has an unclosed quoted cell.');
  row.push(value); if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}
export async function readImportSheets(file: File): Promise<ImportSheet[]> {
  if (!/\.(csv|xlsx|xls)$/i.test(file.name)) throw new ImportValidationError('Choose a CSV, XLSX or XLS file.');
  if (file.size > IMPORT_MAX_BYTES) throw new ImportValidationError('The import file exceeds 10 MB. Split it into smaller files.');
  if (!/\.(xlsx|xls)$/i.test(file.name)) {
    const rows = parseImportCsv(await file.text());
    if (rows.length > MAX_ROWS + 1) throw new ImportValidationError('The import contains more than 50,000 rows.');
    return [{ name: '', rows }];
  }
  const { read, utils } = await import('xlsx');
  let workbook;
  try { workbook = read(await file.arrayBuffer(), { type: 'array', cellDates: false, sheetRows: MAX_ROWS + 6 }); }
  catch { throw new ImportValidationError('Unable to read this workbook. Upload an unencrypted XLSX or XLS file.'); }
  if (workbook.SheetNames.length > 100) throw new ImportValidationError('The workbook contains more than 100 sheets.');
  let total = 0;
  return workbook.SheetNames.map(name => {
    const sheet = workbook.Sheets[name];
    const range = sheet['!fullref'] || sheet['!ref'];
    if (range && utils.decode_range(range).e.r >= MAX_ROWS + 5) throw new ImportValidationError(`Sheet “${name}” exceeds 50,000 rows.`);
    if (range && (utils.decode_range(range).e.r + 1) * (utils.decode_range(range).e.c + 1) > 1_000_000) throw new ImportValidationError(`Sheet “${name}” exceeds one million cells.`);
    const rows = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false });
    total += rows.length;
    if (total > MAX_ROWS + 100) throw new ImportValidationError('The workbook contains more than 50,000 rows.');
    return { name, rows };
  });
}
export function legacyHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s.()/\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}
/** Workbook cover lines may precede the header. Prefer recognized identity columns. */
export function sheetObjects(sheet: ImportSheet, normalize = legacyHeader): Array<Record<string, string>> {
  if (!sheet.rows.length) return [];
  const score = (row: string[]) => row.filter(value => /^(name|first_name|last_name|contact_id|source_no|guest_list_name|email|id|slug|page_type|no)$/.test(legacyHeader(value))).length;
  const candidates = sheet.name ? sheet.rows.slice(0, 5) : sheet.rows.slice(0, 1);
  const best = candidates.reduce((found, row, i) => score(row) > score(candidates[found]) ? i : found, 0);
  const headers = sheet.rows[best].map(normalize);
  const nonempty = headers.filter(Boolean);
  if (new Set(nonempty).size !== nonempty.length) throw new ImportValidationError(`Sheet “${sheet.name || 'CSV'}” has duplicate column names.`);
  if (headers.length > 512) throw new ImportValidationError('The import contains more than 512 columns.');
  return sheet.rows.slice(best + 1).filter(row => row.some(value => value.trim())).map(row => Object.fromEntries(headers.flatMap((header, i) => header ? [[header, row[i] ?? '']] : [])));
}
export function objectsCsv(rows: Array<Record<string, string>>): string {
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const text = csvText([headers, ...rows.map(row => headers.map(header => row[header] ?? ''))]);
  if (new TextEncoder().encode(text).byteLength > 20 * 1024 * 1024) throw new ImportValidationError('The normalized import exceeds 20 MB. Split it into smaller files.');
  return text;
}
