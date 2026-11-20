(() => {
  'use strict';

  const form = document.querySelector('form[data-contact-import-auto]');
  const submit = form?.querySelector('button[type="submit"]');
  const countdown = form?.querySelector('[data-import-countdown]');
  const message = countdown?.querySelector('[data-import-countdown-message]');
  const pause = countdown?.querySelector('[data-import-pause]');
  if (!submit || submit.disabled || !message || !pause || form.dataset.bound) return;
  form.dataset.bound = 'true';

  const changedMode = 'input[type="radio"][name="action"]:checked:not([checked])';
  if (form.querySelector(changedMode)) return;

  let seconds = 3;
  const updateMessage = () => {
    message.textContent = message.dataset.importCountdownMessage.replace('{seconds}', String(seconds));
  };
  const stop = () => {
    clearInterval(timer);
    countdown.hidden = true;
    window.removeEventListener('pagehide', stop);
  };
  const timer = setInterval(() => {
    if (!form.isConnected) {
      stop();
    } else if (--seconds === 0) {
      stop();
      if (!submit.disabled && !form.querySelector(changedMode)) form.requestSubmit(submit);
    } else {
      updateMessage();
    }
  }, 1000);

  pause.addEventListener('click', () => {
    stop();
    (form.querySelector('input[type="radio"][name="action"]:checked') ?? submit).focus();
  });
  document.querySelectorAll('[data-stop-continue]').forEach(link => link.addEventListener('click', stop));
  form.addEventListener('submit', stop);
  form.addEventListener('change', (event) => {
    if (event.target.matches('input[type="radio"][name="action"]')) stop();
  });
  window.addEventListener('pagehide', stop);

  countdown.hidden = false;
  updateMessage();
})();
