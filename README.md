# worker-cms-plugin-import-export

Generic CSV import / export for Workers CMS, extracted from the host CMS so the core
stays lean. One Worker, no database of its own — all page data flows through the host
Plugin API at `{CMS_URL}/__cms/*`.

## Features

- **Export** any page type (or every type at once) to CSV: one column per blueprint
  field (localized fields expand per language, e.g. `name.en`), columns discovered from
  page data, plus one `tag:<taxonomy>` column per taxonomy. Numeric-looking cells are
  `="…"`-armored and formula triggers are neutralized (CSV-injection guard).
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

## Setup

1. Deploy: `npm install && npm run deploy`, then `wrangler secret put PLUGIN_SECRET`.
2. Register in the CMS admin (Plugins → Register) with the Worker URL and the same
   secret.
3. **Approve the wildcard page-type access**: Plugins → import-export → Page types →
   approve `*` for read and write. Without this every call returns
   `forbidden_page_type`.
4. The sidebar gains an "Import / Export" entry under Settings. The host's per-list
   Import/Export buttons and the advanced-search "Export CSV" button link here
   automatically when the plugin is registered.

Access: admins always; other roles need the `content:import` permission (declared in
the manifest, granted per role in the CMS admin).

Local dev: copy `.dev.vars.example` to `.dev.vars`; `PLUGIN_SECRET` must match the host
CMS's `.dev.vars` value, and the host needs the service binding + `PLUGINS` entry (see
the host README).

## Notes

- The legacy JSON import (`/admin/pages/import/:type` textarea) was **not** ported —
  batch-create via the Plugin API covers the use case; open an issue if you relied on
  its uuid-upsert behavior.
- Requires host CMS ≥ the version that ships `GET /__cms/content-meta`,
  `POST /__cms/tags/ensure`, and the `ids`/`slugs`/`include_tags` parameters on
  `GET /__cms/pages` (added together with this plugin's extraction).
