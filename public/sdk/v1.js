/* LeadScroll public intake SDK — v1
 *
 * Embeds a browser token in a plain HTML form:
 *
 *   <form data-leadscroll="lsc_pub_…">
 *     <input name="email" type="email" data-leadscroll-collect required>
 *     <input name="company" data-leadscroll-collect>
 *     <button type="submit">Send</button>
 *   </form>
 *   <script src="https://crm.example.com/sdk/v1.js" defer></script>
 *
 * Only controls marked with data-leadscroll-collect — on the control itself or
 * on an ancestor such as a fieldset — are sent. Unmarked named controls are
 * never transmitted and the SDK warns in the console so a forgotten marker is
 * visible. Fields named email/firstName/lastName/source map to lead columns
 * (first_name and first-name spellings work too); every other marked field
 * becomes a custom field, with repeated names collected as arrays. Password
 * inputs and credential/payment autocomplete fields are never sent, even when
 * marked. Names starting with an underscore are skipped by convention.
 *
 * The origin is taken from this script's own src, so the form can live on any
 * site. No cookies are sent.
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

  const COLLECT = 'data-leadscroll-collect';

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

  // Definitional secrets: refused even when a marker includes them. The
  // autocomplete attribute is a space-separated token list that may carry a
  // section and a mode, so each token is checked individually:
  // `billing cc-number`, `section-blue new-password webauthn`, `cc-exp`.
  const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set(['one-time-code']);
  const isSensitiveAutocomplete = (value) =>
    value
      .trim()
      .toLowerCase()
      .split(/\s+/u)
      .some(
        (token) =>
          token.startsWith('cc-') ||
          token.endsWith('password') ||
          SENSITIVE_AUTOCOMPLETE_TOKENS.has(token),
      );

  // Convention for CSRF, method, and other framework bookkeeping fields.
  const SKIP_NAME = /^_/u;

  const BUTTON_INPUTS = new Set(['button', 'file', 'image', 'reset', 'submit']);

  const newIdempotencyKey = () =>
    window.crypto && typeof window.crypto.randomUUID === 'function'
      ? `sdk-${window.crypto.randomUUID()}`
      : `sdk-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  const isControl = (element) =>
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement;

  const isMarked = (control) => control.closest(`[${COLLECT}]`) !== null;

  const isSensitive = (control) =>
    control instanceof HTMLInputElement &&
    (control.type === 'password' ||
      isSensitiveAutocomplete(control.autocomplete || ''));

  const valuesOf = (control) => {
    if (control instanceof HTMLInputElement) {
      if (BUTTON_INPUTS.has(control.type)) {
        return [];
      }

      if (control.type === 'checkbox' || control.type === 'radio') {
        if (!control.checked) {
          return [];
        }

        return [control.value === '' ? 'on' : control.value];
      }

      return [control.value];
    }

    if (control instanceof HTMLSelectElement) {
      return [...control.selectedOptions].map((option) => option.value);
    }

    if (control instanceof HTMLTextAreaElement) {
      return [control.value];
    }

    return [];
  };

  const addCustom = (customFields, key, value) => {
    const existing = customFields[key];
    if (existing === undefined) {
      customFields[key] = value;
      return;
    }

    if (Array.isArray(existing)) {
      existing.push(value);
      return;
    }

    customFields[key] = [existing, value];
  };

  // Developer diagnostics. Console warnings fire once per distinct skipped set
  // and form; a bubbling `leadscroll:skipped` event carries the field names and
  // reasons (never values) on every build, so monitoring can surface a marker
  // that was forgotten or applied to a sensitive control.
  const warned = new WeakMap();
  const reportSkipped = (form, skipped) => {
    if (skipped.length === 0) {
      return;
    }

    const key = skipped
      .map((entry) => `${entry.reason}:${entry.name}`)
      .toSorted()
      .join(',');
    const seen = warned.get(form) ?? new Set();
    if (!seen.has(key)) {
      seen.add(key);
      warned.set(form, seen);
      const namesOf = (reason) =>
        skipped
          .filter((entry) => entry.reason === reason)
          .map((entry) => entry.name)
          .join(', ');
      const unmarked = namesOf('unmarked');
      const sensitive = namesOf('sensitive');
      if (unmarked) {
        console.warn(
          `LeadScroll: these fields are not marked for collection and were not sent: ${unmarked}. Add ${COLLECT} to collect them.`,
        );
      }

      if (sensitive) {
        console.warn(
          `LeadScroll: these fields are marked but are never sent because they are password inputs or credential/payment autocomplete fields: ${sensitive}.`,
        );
      }
    }

    form.dispatchEvent(
      new CustomEvent('leadscroll:skipped', {
        bubbles: true,
        detail: { fields: skipped },
      }),
    );
  };

  const payloadFor = (form) => {
    const payload = { customFields: {} };
    const skipped = new Map();

    for (const control of form.elements) {
      if (!isControl(control)) {
        continue;
      }

      const name = typeof control.name === 'string' ? control.name.trim() : '';
      if (!name || SKIP_NAME.test(name)) {
        continue;
      }

      if (!isMarked(control)) {
        skipped.set(`unmarked:${name}`, { name, reason: 'unmarked' });
        continue;
      }

      if (isSensitive(control)) {
        skipped.set(`sensitive:${name}`, { name, reason: 'sensitive' });
        continue;
      }

      for (const rawValue of valuesOf(control)) {
        const value = rawValue.trim();
        if (!value) {
          continue;
        }

        const mapped = FIELD_MAP[name.toLowerCase()];
        if (mapped) {
          // Scalar lead fields take the first value; repeats are ignored.
          if (!(mapped in payload)) {
            payload[mapped] = value;
          }
        } else {
          addCustom(payload.customFields, name, value);
        }
      }
    }

    reportSkipped(form, [...skipped.values()]);

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

  const send = async (token, payload, idempotencyKey) => {
    const response = await fetch(
      `${endpointOrigin}/v1/public/intakes/${encodeURIComponent(token)}`,
      {
        body: JSON.stringify(payload),
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey ?? newIdempotencyKey(),
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

  // Per-form submission state: an unchanged payload reuses its idempotency key
  // after a failure and clears it after success, so a lost response cannot
  // create two leads.
  const submissions = new WeakMap();

  const bind = (form) => {
    const token = form.getAttribute('data-leadscroll');
    if (!token) {
      return;
    }

    // Surface collection mistakes as soon as the form is bound.
    payloadFor(form);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (form.getAttribute('data-leadscroll-pending') === 'true') {
        return;
      }

      const button = form.querySelector(
        'button[type="submit"], input[type="submit"]',
      );
      setPending(form, true, button);
      setStatus(form, '');

      const payload = payloadFor(form);
      const body = JSON.stringify(payload);
      const previous = submissions.get(form);
      const idempotencyKey =
        previous && previous.body === body ? previous.key : newIdempotencyKey();
      submissions.set(form, { body, key: idempotencyKey });

      try {
        const responseBody = await send(token, payload, idempotencyKey);
        submissions.delete(form);
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
            detail: responseBody,
          }),
        );
      } catch (error) {
        // Keep the key: retrying the same payload must stay idempotent.
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
    submit: (token, data, options) =>
      send(token, data || {}, options ? options.idempotencyKey : undefined),
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
