import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

function flattenMessages(value: unknown, prefix = '', output: Record<string, string> = {}): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') output[path] = child;
    else flattenMessages(child, path, output);
  }
  return output;
}

async function sectionSources(): Promise<string[]> {
  const directory = fileURLToPath(new URL('../views/sections/', import.meta.url).href);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.liquid'));
  return Promise.all(names.map((name) => readFile(fileURLToPath(new URL(`../views/sections/${name}`, import.meta.url).href), 'utf8')));
}

async function catalog(locale: string): Promise<Record<string, string>> {
  return flattenMessages(JSON.parse(await readFile(
    fileURLToPath(new URL(`../views/locales/${locale}.json`, import.meta.url).href),
    'utf8',
  )));
}

describe('import/export UI locale catalog', () => {
  it('defines every translation key used by plugin admin views', async () => {
    const english = await catalog('en');
    const sources = await sectionSources();
    const usedKeys = sources.flatMap((source) => [
      ...source.matchAll(/["']([a-z0-9_.:-]+)["']\s*\|\s*t\b/gi),
    ]).map((match) => match[1]);

    expect(usedKeys.length).toBeGreaterThan(0);
    expect([...new Set(usedKeys.filter((key) => !(key in english)))]).toEqual([]);
    expect(english['plugins.import-export.nav.index']).toBe('Import / Export');
    expect(english['import-export.import_modes.new_append.label']).toBe('New + Add Missing Fields');
    expect(Object.values(english).some((value) => /[\u0000-\u001f]/.test(value))).toBe(false);
  });

  it('ships complete translated catalogs for each CMS interface locale', async () => {
    const english = await catalog('en');
    for (const locale of ['zh-hans', 'zh-hant']) {
      const localized = await catalog(locale);
      expect(Object.keys(localized).sort()).toEqual(Object.keys(english).sort());
      expect(Object.values(localized).every((value) => value.trim().length > 0)).toBe(true);
      expect(Object.values(localized).some((value) => /[\u0000-\u001f]/.test(value))).toBe(false);
    }
  });

  it('serves each locale catalog through the plugin view contract', async () => {
    const expected = { en: 'Import / Export', 'zh-hans': '导入 / 导出', 'zh-hant': '匯入 / 匯出' };
    const views = {
      async fetch(input: RequestInfo | URL): Promise<Response> {
        const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
        try {
          return new Response(await readFile(fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href), 'utf8'));
        } catch {
          return new Response('not found', { status: 404 });
        }
      },
    } as unknown as Fetcher;
    for (const [locale, label] of Object.entries(expected)) {
      const response = await worker.fetch(new Request(`https://plugin.local/__plugin/views/locales/${locale}.json`), {
        CMS_URL: 'https://cms.local',
        PLUGIN_SECRET: 'test-secret',
        VIEWS: views,
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { plugins?: { 'import-export'?: { nav?: { index?: string } } } };
      expect(body.plugins?.['import-export']?.nav?.index).toBe(label);
    }
  });
});
