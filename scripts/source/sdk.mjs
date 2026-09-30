import assert from 'node:assert/strict';
import { log, error as logError } from 'node:console';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
// Browser SDK behavior tests: explicit collection, sensitive-field refusal,
// repeated values, and retry idempotency. Uses Playwright against the real
// public/sdk/v1.js served from a fake origin with intercepted intake requests.
import { chromium } from 'playwright';

const repoRoot = process.cwd();
const sdkSource = await readFile(join(repoRoot, 'public/sdk/v1.js'), 'utf8');
const origin = 'https://crm.test';
const token = 'lsc_pub_test';

const pass = (message) => log(`PASS ${message}`);

const start = async (browserInstance, html, respond) => {
  const page = await browserInstance.newPage();
  const logs = [];
  const requests = [];
  page.on('console', (message) => logs.push(message.text()));
  await page.route(`${origin}/sdk/v1.js`, (route) =>
    route.fulfill({ body: sdkSource, contentType: 'application/javascript' }),
  );
  await page.route(`${origin}/v1/public/intakes/**`, async (route) => {
    const request = {
      body: JSON.parse(route.request().postData() ?? '{}'),
      key: route.request().headers()['idempotency-key'],
    };
    requests.push(request);
    const response = respond ? respond(request, requests.length) : {};
    await route.fulfill({
      body: JSON.stringify(response.body ?? { data: { created: true } }),
      contentType: 'application/json',
      status: response.status ?? 201,
    });
  });
  await page.setContent(
    `${html}<script src="${origin}/sdk/v1.js" defer></script>`,
  );
  await page.waitForSelector(
    'form[data-leadscroll][data-leadscroll-bound="true"]',
  );
  return { logs, page, requests };
};

const submit = async (page) => {
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('form')
        ?.getAttribute('data-leadscroll-pending') === 'false',
  );
};

const form = (fields, attributes = '') => `
  <form data-leadscroll="${token}"${attributes}>
    ${fields}
    <button type="submit">Send</button>
  </form>`;

let browser;
try {
  browser = await chromium.launch({ headless: true });

  {
    const { logs, page, requests } = await start(
      browser,
      form(
        [
          '<input name="email" value="alex@example.test" data-leadscroll-collect>',
          '<input name="firstName" value="Alex" data-leadscroll-collect>',
          '<input name="company" value="Acme" data-leadscroll-collect>',
          '<input name="unmarked" value="secret-value">',
        ].join(''),
        ' data-leadscroll-source="test_form"',
      ),
    );
    await page.evaluate(() => {
      window.skippedEvents = [];
      document.addEventListener('leadscroll:skipped', (event) => {
        window.skippedEvents.push(event.detail);
      });
    });
    await submit(page);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body, {
      customFields: { company: 'Acme' },
      email: 'alex@example.test',
      firstName: 'Alex',
      skippedFields: [{ name: 'unmarked', reason: 'unmarked' }],
      source: 'test_form',
    });
    assert.ok(!JSON.stringify(requests[0].body).includes('secret-value'));
    const skipped = (await page.evaluate(() => window.skippedEvents)).at(-1);
    assert.deepEqual(skipped, {
      fields: [{ name: 'unmarked', reason: 'unmarked' }],
    });
    assert.ok(
      logs.some(
        (line) =>
          line.includes('not marked for collection') &&
          line.includes('unmarked'),
      ),
    );
    await page.close();
    pass('only marked fields are sent; unmarked fields warn and are dropped');
  }

  {
    const { logs, page, requests } = await start(
      browser,
      form(
        [
          '<fieldset data-leadscroll-collect>',
          '<input name="email" value="alex@example.test">',
          '<input name="phone" value="+1 555 0100">',
          '</fieldset>',
          '<input name="password" type="password" value="hunter2" data-leadscroll-collect>',
          '<input name="card" autocomplete="billing cc-number" value="4111111111111111" data-leadscroll-collect>',
          '<input name="cardExpiry" autocomplete="section-blue cc-exp" value="12/30" data-leadscroll-collect>',
          '<input name="newPassword" autocomplete="new-password webauthn" value="correct-horse" data-leadscroll-collect>',
          '<input name="street" autocomplete="shipping street-address" value="1 Main St" data-leadscroll-collect>',
          '<input name="outside" value="nope">',
        ].join(''),
      ),
    );
    await page.evaluate(() => {
      window.skippedEvents = [];
      document.addEventListener('leadscroll:skipped', (event) => {
        window.skippedEvents.push(event.detail);
      });
    });
    await submit(page);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body, {
      customFields: { phone: '+1 555 0100', street: '1 Main St' },
      email: 'alex@example.test',
      skippedFields: [
        { name: 'password', reason: 'sensitive' },
        { name: 'card', reason: 'sensitive' },
        { name: 'cardExpiry', reason: 'sensitive' },
        { name: 'newPassword', reason: 'sensitive' },
        { name: 'outside', reason: 'unmarked' },
      ],
      source: 'website_form',
    });
    const skippedFields = Object.fromEntries(
      (await page.evaluate(() => window.skippedEvents))
        .at(-1)
        .fields.map((entry) => [entry.name, entry.reason]),
    );
    assert.equal(skippedFields.password, 'sensitive');
    assert.equal(skippedFields.card, 'sensitive');
    assert.equal(skippedFields.cardExpiry, 'sensitive');
    assert.equal(skippedFields.newPassword, 'sensitive');
    assert.equal(skippedFields.outside, 'unmarked');
    assert.equal(skippedFields.street, undefined);
    const serialized = JSON.stringify(requests[0].body);
    assert.ok(!serialized.includes('hunter2'));
    assert.ok(!serialized.includes('4111111111111111'));
    assert.ok(!serialized.includes('12/30'));
    assert.ok(!serialized.includes('correct-horse'));
    const refused = logs.find((line) =>
      line.includes('marked but are never sent'),
    );
    assert.ok(refused, 'sensitive refusal warning expected');
    assert.ok(refused.includes('cardExpiry'));
    assert.ok(refused.includes('newPassword'));
    await page.close();
    pass(
      'ancestor marking collects; password and payment fields are refused even when marked',
    );
  }

  {
    const { page, requests } = await start(
      browser,
      form(
        [
          '<input type="checkbox" name="interests" value="design" checked data-leadscroll-collect>',
          '<input type="checkbox" name="interests" value="engineering" checked data-leadscroll-collect>',
          '<input type="checkbox" name="interests" value="ops" data-leadscroll-collect>',
          '<select name="plans" multiple data-leadscroll-collect>',
          '<option value="starter" selected>Starter</option>',
          '<option value="growth" selected>Growth</option>',
          '<option value="scale">Scale</option>',
          '</select>',
          '<input name="email" value="first@example.test" data-leadscroll-collect>',
          '<input name="email" value="second@example.test" data-leadscroll-collect>',
        ].join(''),
      ),
    );
    await submit(page);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body, {
      customFields: {
        interests: ['design', 'engineering'],
        plans: ['starter', 'growth'],
      },
      email: 'first@example.test',
      source: 'website_form',
    });
    await page.close();
    pass(
      'repeated custom fields become arrays; repeated lead fields keep the first value',
    );
  }

  {
    const { page, requests } = await start(
      browser,
      form(
        '<input name="email" value="retry@example.test" data-leadscroll-collect>',
      ),
      (request, count) =>
        count === 1 ? { body: { message: 'boom' }, status: 500 } : {},
    );
    await submit(page);
    assert.equal(requests.length, 1);
    await submit(page);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].key, requests[1].key);
    await page.close();
    pass('retrying an unchanged payload reuses the same idempotency key');
  }

  {
    const { page, requests } = await start(
      browser,
      form(
        '<input name="email" value="overlap@example.test" data-leadscroll-collect>',
      ),
      () => ({ body: { message: 'slow' }, status: 500 }),
    );
    await page.evaluate(() => {
      const element = document.querySelector('form');
      element.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      element.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('form')
          ?.getAttribute('data-leadscroll-pending') === 'false',
    );
    assert.equal(requests.length, 1);
    await page.close();
    pass('overlapping submits are ignored while a submission is pending');
  }

  {
    const { page, requests } = await start(browser, form(''));
    const request = page.waitForRequest(`${origin}/v1/public/intakes/**`);
    await page.evaluate(
      (value) =>
        window.LeadScroll.submit(
          value,
          { email: 'programmatic@example.test' },
          { idempotencyKey: 'caller-key' },
        ),
      token,
    );
    await (await request).response();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].key, 'caller-key');
    assert.deepEqual(requests[0].body, { email: 'programmatic@example.test' });
    await page.close();
    pass('programmatic submit sends a caller-supplied idempotency key');
  }
} catch (error) {
  logError('FAIL', error);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
