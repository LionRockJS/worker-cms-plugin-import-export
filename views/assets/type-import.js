(() => {
  'use strict';

  const root = document.querySelector('[data-type-import-root]');
  if (!root) return;

  const payloadNode = document.querySelector('#type-import-payload');
  const applyButton = root.querySelector('[data-type-import-apply]');
  const summary = root.querySelector('[data-type-import-status]');
  if (!(payloadNode instanceof HTMLTextAreaElement)
    || !(applyButton instanceof HTMLButtonElement)
    || !(summary instanceof HTMLElement)) return;

  function message(name, fallback) {
    return root.dataset[name] || fallback;
  }

  function format(name, fallback, values) {
    let text = message(name, fallback);
    Object.entries(values || {}).forEach(([key, value]) => {
      text = text.replaceAll(`{${key}}`, String(value));
    });
    return text;
  }

  function kindLabel(kind) {
    return kind === 'block'
      ? message('typeImportBlockType', 'block type')
      : message('typeImportPageType', 'page type');
  }

  function setRowStatus(kind, slug, text, className) {
    const row = [...root.querySelectorAll('[data-type-import-row]')]
      .find((entry) => entry.getAttribute('data-type-import-row') === `${kind}:${slug}`);
    const status = row && row.querySelector('[data-type-import-row-status]');
    if (!(status instanceof HTMLElement)) return;
    status.textContent = text;
    status.className = `px-4 py-3 text-sm ${className || 'text-gray-500'}`;
  }

  async function typeSlugs(kind) {
    const base = kind === 'block' ? '/admin/block_types' : '/admin/page_types';
    // The list is read immediately after a native type-admin POST. Explicitly
    // bypass the browser cache because a stale list makes a successful create
    // look like a failed one.
    const response = await fetch(`${base}?_type_import_refresh=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) {
      throw new Error(format('typeImportReadError', 'Could not read {kind} types ({status}).', {
        kind: kindLabel(kind),
        status: response.status,
      }));
    }

    const document = new DOMParser().parseFromString(await response.text(), 'text/html');

    // Current CMS admin pages are client-rendered: the response contains a
    // loading shell and the actual list in cms-render-payload. Scraping the
    // response's table therefore returns no rows even though the rendered
    // page visibly lists existing types.
    const payload = document.querySelector('#cms-render-payload');
    if (payload?.textContent) {
      try {
        const parsed = JSON.parse(payload.textContent);
        const types = parsed?.bodyView?.data?.types;
        if (Array.isArray(types)) {
          return new Set(types
            .map((type) => type && typeof type.slug === 'string' ? type.slug.trim() : '')
            .filter(Boolean));
        }
      } catch {
        // Fall through to the legacy rendered-table parser below.
      }
    }

    // Older/full-document hosts render the table directly in the response.
    const slugs = new Set();
    document.querySelectorAll('table tbody tr').forEach((row) => {
      const cells = row.querySelectorAll('td');
      const slug = cells[1] && cells[1].textContent ? cells[1].textContent.trim() : '';
      if (slug) slugs.add(slug);
    });
    return slugs;
  }

  function typeForm(kind, type) {
    const form = new FormData();
    form.set('name', type.name);
    form.set('slug', kind === 'block' ? type.block_type : type.page_type);
    form.set('blueprint', JSON.stringify(type.blueprint));
    form.set('weight', '5');
    if (kind === 'page') {
      for (const block of type.block_types || []) form.append('block_lists', block);
      for (const taxonomy of type.taxonomy_types || []) form.append('taxonomy_lists', taxonomy);
    }
    return form;
  }

  async function createType(kind, type) {
    const slug = kind === 'block' ? type.block_type : type.page_type;
    const base = kind === 'block' ? '/admin/block_types' : '/admin/page_types';
    setRowStatus(kind, slug, message('typeImportCreating', 'Creating…'), 'text-indigo-700');
    const response = await fetch(base, {
      method: 'POST',
      body: typeForm(kind, type),
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new Error(format('typeImportCreateError', 'The CMS rejected {kind} “{slug}” ({status}).', {
        kind: kindLabel(kind),
        slug,
        status: response.status,
      }));
    }

    // The native route follows a successful redirect to a 200 page, while a
    // validation failure is also 200. Verify both against a fresh shell
    // payload so only a real type-list entry counts as success.
    const slugs = await typeSlugs(kind);
    if (!slugs.has(slug)) {
      throw new Error(format('typeImportNotCreatedError', 'The CMS did not create {kind} “{slug}”. Check its type-admin permissions and blueprint.', {
        kind: kindLabel(kind),
        slug,
      }));
    }
    setRowStatus(kind, slug, message('typeImportCreated', 'Created'), 'text-emerald-700');
  }

  applyButton.addEventListener('click', async () => {
    applyButton.disabled = true;
    applyButton.classList.add('cursor-not-allowed', 'opacity-75');
    summary.textContent = message('typeImportReading', 'Reading the destination type lists…');

    let setup;
    try {
      setup = JSON.parse(payloadNode.value);
    } catch {
      summary.textContent = message('typeImportPreviewError', 'The preview payload could not be read. Upload the setup file again.');
      applyButton.disabled = false;
      applyButton.classList.remove('cursor-not-allowed', 'opacity-75');
      return;
    }

    try {
      let blockSlugs = await typeSlugs('block');
      for (const type of setup.block_types || []) {
        const slug = type.block_type;
        if (blockSlugs.has(slug)) {
          setRowStatus('block', slug, message('typeImportExisting', 'Existing — unchanged'), 'text-gray-500');
          continue;
        }
        await createType('block', type);
        blockSlugs = await typeSlugs('block');
      }

      let pageSlugs = await typeSlugs('page');
      for (const type of setup.page_types || []) {
        const slug = type.page_type;
        if (pageSlugs.has(slug)) {
          setRowStatus('page', slug, message('typeImportExisting', 'Existing — unchanged'), 'text-gray-500');
          continue;
        }
        const missingBlocks = (type.block_types || []).filter((block) => !blockSlugs.has(block));
        if (missingBlocks.length > 0) {
          throw new Error(format('typeImportMissingBlocksError', 'Cannot create page type “{slug}”: missing block type(s) {blocks}.', {
            slug,
            blocks: missingBlocks.join(', '),
          }));
        }
        await createType('page', type);
        pageSlugs = await typeSlugs('page');
      }

      summary.textContent = message('typeImportApplied', 'Type setup applied. Existing definitions were left unchanged; you can now import the CSV pages.');
      summary.className = 'mt-1 text-sm font-medium text-emerald-800';
    } catch (error) {
      summary.textContent = error instanceof Error ? error.message : message('typeImportApplyError', 'The type setup could not be applied.');
      summary.className = 'mt-1 text-sm font-medium text-red-700';
      applyButton.disabled = false;
      applyButton.classList.remove('cursor-not-allowed', 'opacity-75');
    }
  });
})();
