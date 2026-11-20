import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const SECRET = 'test-secret';

/** VIEWS asset binding stub: serves the real files from views/. */
const views = {
  async fetch(input: RequestInfo | URL): Promise<Response> {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href).pathname;
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    try {
      const body = await readFile(fileURLToPath(new URL(`../views${path}`, import.meta.url).toString()), 'utf8');
      return new Response(body, { status: 200 });
    } catch {
      return new Response('not found', { status: 404 });
    }
  },
} as unknown as Fetcher;

function env() {
  return { CMS_URL: 'https://cms.local', PLUGIN_SECRET: SECRET, VIEWS: views };
}

function adminRequest(path: string): Request {
  return new Request(`https://plugin.local${path}`, {
    headers: { 'x-plugin-secret': SECRET, 'x-cms-user': JSON.stringify({ id: '1', role: 'admin' }) },
  });
}

function confirmImport(csv: string, fields: Record<string, string> = {}): Promise<Response> {
  const request = adminRequest('/__plugin/admin/import/contact/confirm');
  return worker.fetch(new Request(request, {
    method: 'POST',
    body: new URLSearchParams({ csv, ...fields }),
  }), env());
}

const contactMeta = {
  page_types: ['contact'],
  default_language: 'en',
  languages: ['en'],
  path_specs: {},
  taxonomies: [{ name: 'Industry', slug: 'industry' }],
};

describe('plugin worker routes', () => {
  it('serves the manifest', async () => {
    const response = await worker.fetch(new Request('https://plugin.local/__plugin/manifest'), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'import-export',
      i18n: true,
      nav: [{ label: 'Import / Export', href: '', group: 'settings' }],
    });
  });

  it('serves client-view templates under /__plugin/admin/views/* (the host view proxy path)', async () => {
    // The CMS proxies browser requests for /admin/plugins/<id>/views/* to
    // /__plugin/admin/views/* — a regression here renders blank admin pages.
    const template = await worker.fetch(adminRequest('/__plugin/admin/views/templates/home.json'), env());
    expect(template.status).toBe(200);
    expect(await template.json()).toMatchObject({ sections: { main: { type: 'home' } } });

    const section = await worker.fetch(adminRequest('/__plugin/admin/views/sections/import.liquid'), env());
    expect(section.status).toBe(200);
    const importSection = await section.text();
    expect(importSection).toContain('import-export.views.import.confirm_import');
    expect(importSection).toContain('data-import-drop-zone');
    expect(importSection).toContain('src="/admin/plugins/import-export/assets/contact-import-drop.js"');

    const typeSection = await worker.fetch(adminRequest('/__plugin/admin/views/sections/type-import.liquid'), env());
    expect(typeSection.status).toBe(200);
    expect(await typeSection.text()).toContain('import-export.views.type_import.apply_missing_types');
  });

  it('also serves views at the direct /__plugin/views/* contract path', async () => {
    const response = await worker.fetch(new Request('https://plugin.local/__plugin/views/templates/import.json'), env());
    expect(response.status).toBe(200);
  });

  it('serves the approved type-import asset', async () => {
    const response = await worker.fetch(new Request('https://plugin.local/assets/type-import.js'), env());
    expect(response.status).toBe(200);
    const script = await response.text();
    expect(script).toContain("/admin/block_types");
    expect(script).toContain("cache: 'no-store'");
    expect(script).toContain("cms-render-payload");
    expect(script).toContain("bodyView?.data?.types");
    expect(script).not.toContain('isSkippedSlug');
    expect(script).not.toContain('typeImportAppliedWithSkips');

    const proxied = await worker.fetch(adminRequest('/__plugin/admin/assets/type-import.js'), env());
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get('content-type')).toContain('text/javascript');
  });

  it.each(['contact-import-drop.js', 'contact-import-auto.js'])('declares and serves %s for CMS approval', async (name) => {
    const path = `/assets/${name}`;
    const manifest = await worker.fetch(new Request('https://plugin.local/__plugin/manifest'), env());
    expect(await manifest.json()).toMatchObject({
      assets: expect.arrayContaining([expect.objectContaining({ path })]),
    });

    const asset = await worker.fetch(new Request(`https://plugin.local${path}`), env());
    const proxied = await worker.fetch(adminRequest(`/__plugin/admin${path}`), env());
    expect(asset.status).toBe(200);
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get('content-type')).toContain('text/javascript');
    expect(await proxied.text()).toBe(await asset.text());
  });

  it('rejects admin calls without the plugin secret', async () => {
    const response = await worker.fetch(new Request('https://plugin.local/__plugin/admin'), env());
    expect(response.status).toBe(403);
  });

  it('renders an approval hint when the CMS denies contact metadata access', async () => {
    const cmsFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: 'forbidden_page_type', page_type: 'contact' }, { status: 403 }),
    );
    vi.stubGlobal('fetch', cmsFetch);
    try {
      const response = await worker.fetch(adminRequest('/__plugin/admin/import/contact'), env());
      expect(cmsFetch).toHaveBeenCalledWith('https://cms.local/__cms/content-meta?types=contact', expect.anything());
      expect(response.headers.get('x-cms-view-path')).toBe('/templates/error.json');
      expect(await response.json()).toMatchObject({
        message: expect.stringContaining('approve Read for All page types'),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('import confirmation passes', () => {
  it.each([
    { pageType: 'contact', csv: 'name\nAda', autoImport: true },
    { pageType: 'contact', csv: 'page_type,name\ncontact,Ada\narticle,News', autoImport: false },
    { pageType: 'contact', csv: 'page_type,name\nunknown,Ada', autoImport: false },
    { pageType: 'article', csv: 'name\nNews', autoImport: false },
  ])('sets preview auto-import to $autoImport for $pageType and $csv', async ({ pageType, csv, autoImport }) => {
    vi.stubGlobal('fetch', async (input: string) => {
      expect(new URL(input).pathname).toBe('/__cms/content-meta');
      return Response.json({ ...contactMeta, page_types: ['contact', 'article'] });
    });
    try {
      const request = adminRequest(`/__plugin/admin/import/${pageType}`);
      const response = await worker.fetch(new Request(request, {
        method: 'POST',
        body: new URLSearchParams({ csv }),
      }), env());
      expect(response.headers.get('x-cms-view-path')).toBe('/templates/import.json');
      expect(await response.json()).toMatchObject({ isConfirmImport: true, autoImport });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns saved progress when two full-size CMS create calls would exceed the proxy deadline', async () => {
    const names = Array.from({ length: 200 }, (_, i) => `Contact ${i + 1}`);
    const csv = ['name', ...names].join('\n');
    const saved: string[] = [];
    const batchSizes: number[] = [];
    let now = Date.now();
    let requestStarted = now;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const { pathname } = new URL(input);
      if (pathname === '/__cms/content-meta') return Response.json(contactMeta);
      if (pathname === '/__cms/pages/batch') {
        const { pages } = JSON.parse(String(init?.body)) as { pages: Array<{ name: string }> };
        now += pages.length * 76;
        if (now - requestStarted >= 15_000) throw new DOMException('Plugin proxy deadline exceeded', 'TimeoutError');
        batchSizes.push(pages.length);
        saved.push(...pages.map(page => page.name));
        return Response.json({ created: pages, errors: [] });
      }
      throw new Error(`Unexpected CMS request ${pathname}`);
    });
    try {
      const first = await confirmImport(csv, { action: 'force-new' });
      expect(first.headers.get('x-cms-view-path')).toBe('/templates/import-progress.json');
      expect(await first.json()).toMatchObject({ offset: 100, totalRows: 200, created: 100 });
      expect(saved).toEqual(names.slice(0, 100));

      requestStarted = now;
      const last = await confirmImport(csv, { action: 'force-new', offset: '100', created: '100' });
      expect(decodeURIComponent(last.headers.get('location')!)).toContain('200 created, 0 updated, 0 skipped');
      expect(batchSizes).toEqual(Array(8).fill(25));
      expect(saved).toEqual(names);
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('returns a continuation before slow updates exceed the proxy deadline', async () => {
    const csv = 'id,name\n1,Ada\n2,Bea\n3,Chloe\n4,Dina';
    const updated: string[] = [];
    const lookups: string[] = [];
    let now = Date.now();
    let requestStarted = now;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === '/__cms/content-meta') return Response.json(contactMeta);
      if (url.pathname === '/__cms/pages') {
        const ids = url.searchParams.get('ids')!;
        lookups.push(ids);
        return Response.json({ pages: ids.split(',').map(id => ({ id: Number(id), name: 'Old name' })) });
      }
      if (init?.method === 'PUT') {
        now += 4_500;
        if (now - requestStarted >= 15_000) throw new DOMException('Plugin proxy deadline exceeded', 'TimeoutError');
        updated.push(url.pathname.split('/').at(-1)!);
        return Response.json({ page: {} });
      }
      throw new Error(`Unexpected CMS request ${url.pathname}`);
    });
    try {
      const first = await confirmImport(csv, { action: 'overwrite' });
      expect(first.headers.get('x-cms-view-path')).toBe('/templates/import-progress.json');
      expect(await first.json()).toMatchObject({ autoImport: true, offset: 2, totalRows: 4, updated: 2 });
      expect(updated).toEqual(['1', '2']);

      requestStarted = now;
      const last = await confirmImport(csv, { action: 'overwrite', offset: '2', updated: '2' });
      expect(updated).toEqual(['1', '2', '3', '4']);
      expect(lookups).toEqual(['1,2,3,4', '3,4']);
      expect(decodeURIComponent(last.headers.get('location')!)).toContain('0 created, 4 updated, 0 skipped');
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('leaves tags for rows beyond the current pass to the continuation', async () => {
    const csv = ['name,tag:Industry', ...Array.from({ length: 100 }, (_, i) => `Contact ${i + 1},`), 'Last contact,Technology'].join('\n');
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const { pathname } = new URL(input);
      requests.push(pathname);
      if (pathname === '/__cms/content-meta') return Response.json(contactMeta);
      if (pathname === '/__cms/pages/batch') return Response.json({ created: JSON.parse(String(init?.body)).pages, errors: [] });
      if (pathname === '/__cms/tags/ensure') return Response.json({ tags: [{ taxonomy: 'industry', name: 'Technology', id: 1 }] });
      throw new Error(`Unexpected CMS request ${pathname}`);
    });
    try {
      const first = await confirmImport(csv, { action: 'force-new' });
      expect(first.headers.get('x-cms-view-path')).toBe('/templates/import-progress.json');
      expect(await first.json()).toMatchObject({ offset: 100, totalRows: 101, created: 100 });
      expect(requests).not.toContain('/__cms/tags/ensure');

      requests.length = 0;
      const last = await confirmImport(csv, { action: 'force-new', offset: '100', created: '100' });
      expect(requests).toEqual(['/__cms/content-meta', '/__cms/tags/ensure', '/__cms/pages/batch']);
      expect(decodeURIComponent(last.headers.get('location')!)).toContain('101 created, 0 updated, 0 skipped');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
