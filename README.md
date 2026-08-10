# worker-cms-plugin-import-export

Generic CSV import / export for Workers CMS, extracted from the host CMS so the core
stays lean. One Worker, no database of its own — page data flows through the host
Plugin API at `{CMS_URL}/__cms/*`; type setup writes use the destination CMS's
authenticated type-admin routes.

## Features

- **Export** any page type (or every type at once) to CSV: one column per blueprint
  field (localized fields expand per language, e.g. `name.en`), columns discovered from
  page data, plus one `tag:<taxonomy>` column per taxonomy and explicit `page_type` /
  `block_type` metadata columns. Numeric-looking cells are
  `="…"`-armored and formula triggers are neutralized (CSV-injection guard).
- **Type setup export**: download `content-types-export-*.json` from the plugin home
  to inventory page types, structured block types, field paths, languages, and taxonomies
  before importing into another environment. Hosts that expose raw type definitions also
  include the original blueprints in this file.
- **Type setup import**: upload that JSON on the plugin home to review and create missing
  database-defined block/page types in the destination. Block types are created first so page
  block lists can resolve. Existing config, plugin, and database definitions are skipped and
  never overwritten; languages and taxonomies are reported but are not changed by this feature.
- **Advanced-search export**: accepts the exact query string of the admin
  advanced-search page (`search1`/`path1`/`tags1`…, `operator`, `page_type`, `sort`,
  `order`) at `…/export-search`, so the host links its "Export CSV" button here.
- **Import** with preview: rows are matched to existing pages by `id` (preferred) or
  `slug`, previewed as create/update tables, then applied with one of six modes
  (new only, fill blanks, replace fields, force-new, …) — the same semantics the host's
  built-in importer had. Tags are created on demand. Large files apply in budgeted
  passes with a "Continue import" step so a single request never blows the Worker
  subrequest cap.
- **Multi-type imports**: each row's `page_type` column overrides the import page's
  type — matching, blueprint columns and creation all follow the row's own type, so an
  "Export all page types" file round-trips through "Import all page types". Rows with
  a missing or unknown `page_type` are skipped (a typo can never mint a junk type) and
  reported on the preview screen.
- Structured block fields and `block_type` metadata are preserved when their columns are
  present in the CSV, including fields discovered from stored lect data.

After importing the type setup, use **Import all page types** for the CSV. Rows with missing or
unknown `page_type` remain skipped and are reported rather than being created under an unintended
type. The type bulk action requires the destination CMS's `pagetype:write` and `blocktype:write`
permissions (the native fallback forms use the same permissions). Approve the plugin's
**Type setup importer** asset under Plugins → import-export → Assets; individual native forms are
also available on the review screen if the asset has not been approved yet.

## Setup

1. Deploy: `npm install && npm run deploy`, then `wrangler secret put PLUGIN_SECRET`.
2. Register the Worker HTTPS URL in the CMS admin (**Plugins → Register**) and
   configure this plugin's dedicated shared secret.
3. **Approve the wildcard page-type access**: Plugins → import-export → Page types →
   approve `*` for read and write. Without this every call returns
   `forbidden_page_type`.
4. **Approve the Type setup importer asset**: Plugins → import-export → Assets → approve
   `type-import.js`. The review screen still includes individual native forms if you skip this.
5. The sidebar gains an "Import / Export" entry under Settings. The host's per-list
   Import/Export buttons and the advanced-search "Export CSV" button link here
   automatically when the plugin is registered.

Access: admins always; other roles need the `content:import` permission (declared in
the manifest, granted per role in the CMS admin).

Local dev: copy `.dev.vars.example` to `.dev.vars`; `PLUGIN_SECRET` must match
this plugin's registered secret. The manifest is `trusted-ui` + `autoTenant`,
so a deployed CMS Connect action enrolls the Worker into `TENANTS` KV. The
`CMS_URL` + `PLUGIN_SECRET` variables remain a single-tenant fallback; no host
service binding or `PLUGINS` list is required for URL transport.

### Multi-tenant (one Worker, several CMS hosts)

One deployed plugin Worker can serve many CMS installs. Each connected CMS is a
*tenant* — a `tenant:<canonical-origin>` record in the `TENANTS` KV namespace holding
that host's own `{ secret, cmsUrl }`. The host sends its canonical origin in the
`x-cms-tenant` header; the plugin verifies `x-plugin-secret` against **that** tenant's
record, so each CMS is isolated to its own pairwise secret and URL.

```sh
npm run kv:setup                # create the TENANTS namespace + write its id into wrangler.toml
npm run kv:setup:preview        # (optional) preview namespace for `wrangler dev`
npm run tenant:add -- https://cms1.example.com   # register a tenant (prints its secret)
npm run tenant:add -- https://cms2.example.com --url https://api.cms2.example.com
npm run kv:list                 # list registered tenants
npm run deploy
```

`tenant:add` generates a random shared secret and prints it once — set the same value on
that host under Plugins → import-export → Edit → Shared secret. Pass `--secret <value>`
to supply your own, `--local` to write to the `wrangler dev` KV, `--preview` for the
preview namespace, `--dry-run` to preview without writing.

Single-tenant installs skip all of this: set `CMS_URL` + `PLUGIN_SECRET` (env / `wrangler
secret` / `.dev.vars`) and the plugin synthesizes one tenant with no KV needed — the
`TENANTS` binding can be left unconfigured.

## Notes

- The legacy JSON import (`/admin/pages/import/:type` textarea) was **not** ported —
  batch-create via the Plugin API covers the use case; open an issue if you relied on
  its uuid-upsert behavior.
- Type setup import requires the destination CMS's runtime content-types feature and an
  operator with `pagetype:write` / `blocktype:write`; it does not install missing CMS
  features or create taxonomies/languages.
- Requires host CMS ≥ the version that ships `GET /__cms/content-meta`,
  `POST /__cms/tags/ensure`, and the `ids`/`slugs`/`include_tags` parameters on
  `GET /__cms/pages` (added together with this plugin's extraction).
