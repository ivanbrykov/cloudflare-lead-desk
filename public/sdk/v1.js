/* LeadScroll public intake SDK — v1
 *
 * Embeds a browser token in a plain HTML form:
 *
 *   <form data-leadscroll="lsc_pub_…">
 *     <input name="email" type="email" required>
 *     <button type="submit">Send</button>
 *   </form>
 *   <script src="https://crm.example.com/sdk/v1.js" defer></script>
 *
 * Named fields email/firstName/lastName are mapped to lead fields
 * (first_name and first-name spellings work too); every other named field is
 * sent as a custom field. The origin is taken from this script's own src, so
 * the form can live on any site. No cookies are sent.
 */
(() => {
  const scriptSource = (() => {
    const current = document.currentScript;
    if (current && current.src) {
      return current.src;
    }

    const scripts = document.querySelectorAll('script[src*="/sdk/v1.js"]');
    return scripts.length > 0 ? scripts[scripts.length - 1].src : '';
  })();

  const endpointOrigin = (() => {
    try {
      return new URL(scriptSource || window.location.href).origin;
    } catch {
      return window.location.origin;
    }
  })();

  const FIELD_MAP = {
    email: 'email',
    'first-name': 'firstName',
    first_name: 'firstName',
    firstname: 'firstName',
    'last-name': 'lastName',
    last_name: 'lastName',
    lastname: 'lastName',
    source: 'source',
  };

  // Never collect values a public form has no business sending upstream.
  const SKIP_FIELD = /password|passwd|card|cvv|cvc|iban|secret|token/iu;

  const newIdempotencyKey = () =>
    window.crypto && typeof window.crypto.randomUUID === 'function'
      ? `sdk-${window.crypto.randomUUID()}`
      : `sdk-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  const payloadFor = (form) => {
    const payload = { customFields: {} };
    const data = new FormData(form);
    for (const [rawName, rawValue] of data.entries()) {
      if (typeof rawValue !== 'string') {
        continue;
      }

      const value = rawValue.trim();
      const key = String(rawName).trim();
      if (!value || !key || key.startsWith('_') || SKIP_FIELD.test(key)) {
        continue;
      }

      const mapped = FIELD_MAP[key.toLowerCase()];
      if (mapped) {
        payload[mapped] = value;
      } else {
        payload.customFields[key] = value;
      }
    }

    if (!payload.source) {
      payload.source =
        form.getAttribute('data-leadscroll-source') || 'website_form';
    }

    if (Object.keys(payload.customFields).length === 0) {
      delete payload.customFields;
    }

    return payload;
  };

  const setStatus = (form, message) => {
    const element = form.querySelector('[data-leadscroll-status]');
    if (element) {
      element.textContent = message;
    }
  };

  const setPending = (form, pending, button) => {
    if (button) {
      button.disabled = pending;
    }

    form.setAttribute('data-leadscroll-pending', pending ? 'true' : 'false');
  };

  const send = async (token, payload) => {
    const response = await fetch(
      `${endpointOrigin}/v1/public/intakes/${encodeURIComponent(token)}`,
      {
        body: JSON.stringify(payload),
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': newIdempotencyKey(),
        },
        method: 'POST',
      },
    );
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }

    if (!response.ok) {
      const failure = new Error((body && body.message) || 'Submission failed.');
      failure.status = response.status;
      failure.body = body;
      throw failure;
    }

    return body;
  };

  const bind = (form) => {
    const token = form.getAttribute('data-leadscroll');
    if (!token) {
      return;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector(
        'button[type="submit"], input[type="submit"]',
      );
      setPending(form, true, button);
      setStatus(form, '');
      try {
        const body = await send(token, payloadFor(form));
        setPending(form, false, button);
        setStatus(
          form,
          form.getAttribute('data-leadscroll-success') ||
            'Thanks — we will be in touch.',
        );
        if (form.getAttribute('data-leadscroll-reset') !== 'false') {
          form.reset();
        }

        form.dispatchEvent(
          new CustomEvent('leadscroll:success', {
            bubbles: true,
            detail: body,
          }),
        );
      } catch (error) {
        setPending(form, false, button);
        setStatus(
          form,
          form.getAttribute('data-leadscroll-error') ||
            'Something went wrong. Please try again.',
        );
        form.dispatchEvent(
          new CustomEvent('leadscroll:error', {
            bubbles: true,
            detail: { body: error.body, error },
          }),
        );
      }
    });

    form.setAttribute('data-leadscroll-bound', 'true');
  };

  const init = (root) => {
    const scope = root || document;
    const forms = scope.querySelectorAll(
      'form[data-leadscroll]:not([data-leadscroll-bound])',
    );
    for (const form of forms) {
      bind(form);
    }
  };

  window.LeadScroll = {
    init,
    submit: (token, data) => send(token, data || {}),
    version: 'v1',
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
    });
  } else {
    init();
  }
})();
