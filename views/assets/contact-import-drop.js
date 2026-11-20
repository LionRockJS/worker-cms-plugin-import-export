(() => {
  'use strict';

  const zone = document.querySelector('[data-import-drop-zone]');
  const input = zone?.querySelector('input[type="file"]');
  const hint = zone?.querySelector('[data-import-drop-hint]');
  const status = document.querySelector('[data-import-drop-status]');
  if (!input || !hint || !status || zone.dataset.bound) return;
  zone.dataset.bound = 'true';

  zone.classList.add('rounded-lg', 'border', 'border-dashed', 'border-gray-300', 'p-3');
  hint.classList.add('block');
  hint.hidden = false;

  zone.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    zone.classList.add('bg-indigo-50');
  });

  zone.addEventListener('dragleave', (event) => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('bg-indigo-50');
  });

  zone.addEventListener('drop', (event) => {
    zone.classList.remove('bg-indigo-50');
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();

    const { files } = event.dataTransfer;
    if (files.length !== 1) {
      status.textContent = status.dataset.singleFileMessage;
      return;
    }

    input.files = files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  input.addEventListener('change', () => {
    status.textContent = '';
  });
})();
