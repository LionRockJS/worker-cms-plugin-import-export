import { describe, expect, it } from 'vitest';
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
    expect(await section.text()).toContain('import-export.views.import.confirm_import');

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

    const proxied = await worker.fetch(adminRequest('/__plugin/admin/assets/type-import.js'), env());
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get('content-type')).toContain('text/javascript');
  });

  it('rejects admin calls without the plugin secret', async () => {
    const response = await worker.fetch(new Request('https://plugin.local/__plugin/admin'), env());
    expect(response.status).toBe(403);
  });
});
