// ============================================================
// Worker CMS plugin — generic CSV import / export.
//
// Extracted from the host CMS (its /admin/pages/import-v2, /admin/pages/export
// and /admin/advanced-search-export routes) so the host stays lean. The CMS
// proxies /admin/plugins/import-export/<rest> to /__plugin/admin/<rest> here;
// all page data flows back through the host Plugin API at {CMS_URL}/__cms/*.
//
// The manifest declares contentTypes.readTypes/writeTypes = ["*"]: after an
// admin approves the wildcard under Plugins → import-export → Page types, the
// plugin can export and import every page type on the site.
// ============================================================

import { requirePluginSecret, serveViewAsset } from '@lionrockjs/worker-cms-plugin';
import { handleAdmin, type AdminEnv } from './admin';
import MANIFEST from './manifest.json';

interface PluginEnv extends AdminEnv {
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export default {
  async fetch(request: Request, env: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/__plugin/manifest') {
      return Response.json({
        ...MANIFEST,
        ...(env.CF_VERSION_METADATA ? { workerVersion: env.CF_VERSION_METADATA } : {}),
      });
    }

    // Plugin-owned view templates, served to the CMS's composite view resolver.
    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length) || '/';
      return serveViewAsset(env.VIEWS, assetPath);
    }

    if (path.startsWith('/__plugin/admin')) {
      const forbidden = requirePluginSecret(request, env.PLUGIN_SECRET);
      if (forbidden) return forbidden;
      return handleAdmin(request, env, url);
    }

    return new Response('not found', { status: 404 });
  },
};
