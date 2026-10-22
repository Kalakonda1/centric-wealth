// End-to-end smoke tests of the app (index.html) on a phone-sized screen.
import { test, expect } from '@playwright/test';

const ignorable = (m) => /in-browser Babel|Service Worker|cdn\.tailwindcss\.com should not be used/i.test(m);

test.beforeEach(async ({ page }, info) => {
  info.errors = [];
  page.on('pageerror', (e) => info.errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !ignorable(m.text()) && info.errors.push(m.text()));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
});
test.afterEach(async ({}, info) => { expect(info.errors, 'page errors').toEqual([]); });

test('sample data fills the dashboard', async ({ page }) => {
  await page.getByRole('button', { name: 'Try sample' }).click();
  await expect(page.getByText('Sample data loaded')).toBeVisible();
  await expect(page.getByText('Combined net balance')).toBeVisible();
  await expect(page.locator('[data-testid=card-tracker]')).toContainText('Visa Card');
  for (const tab of ['Activity', 'Upload', 'Budget', 'Advisor', 'Settings', 'Dashboard']) {
    await page.locator('nav').getByText(tab, { exact: true }).click();
  }
  await expect(page.getByText('Combined net balance')).toBeVisible();
});

test('imports a credit card statement and saves card details', async ({ page }) => {
  await page.locator('nav').getByText('Upload').click();
  await page.getByRole('radio', { name: /Credit Card Statement/ }).click();
  await page.getByPlaceholder('e.g. Amex Gold').fill('Test Card');
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/card2.pdf');
  await expect(page.getByText('Preview · Test Card')).toBeVisible();
  await expect(page.locator('[data-testid=statement-check]')).toContainText('Adds up');
  await page.getByRole('button', { name: /Import 7 into Test Card/ }).click();
  await expect(page.getByText('Imported 7 into Test Card').first()).toBeVisible();
  const card = await page.evaluate(() => FinanceDB.getAll('debts').then((d) => d[0]));
  expect(card).toMatchObject({ name: 'Test Card', balance: 1186.41, kind: 'credit' });
});

test('imports several statements at once', async ({ page }) => {
  await page.locator('nav').getByText('Upload').click();
  await page.getByRole('radio', { name: /Credit Card Statement/ }).click();
  await page.getByPlaceholder('e.g. Amex Gold').fill('Visa Rewards');
  await page.locator('input[type=file]').setInputFiles(['tests/fixtures/messy1.csv', 'tests/fixtures/messy2.csv']);
  await expect(page.getByRole('button', { name: 'Import 16 transactions from 2 statements' })).toBeEnabled();
  await page.getByRole('button', { name: 'Import 16 transactions from 2 statements' }).click();
  await expect(page.getByText('Import finished')).toBeVisible();
  const n = await page.evaluate(() => FinanceDB.getAll('transactions').then((t) => t.length));
  expect(n).toBe(16);
});

test('recategorising remembers the merchant for future imports', async ({ page }) => {
  await page.locator('nav').getByText('Upload').click();
  await page.getByRole('radio', { name: /Credit Card Statement/ }).click();
  await page.getByPlaceholder('e.g. Amex Gold').fill('Visa Rewards');
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/messy1.csv');
  await page.getByRole('button', { name: 'Import 14 into Visa Rewards' }).click();
  await page.locator('nav').getByText('Activity').click();
  await page.locator('button[aria-pressed]', { hasText: 'Needs category' }).click();
  await page.locator('main button', { hasText: 'CABELAS #123' }).first().click();
  const dlg = page.locator('[role=dialog]');
  await dlg.locator('label', { hasText: 'Category' }).locator('select').selectOption('Shopping');
  await expect(dlg.locator('[data-testid=remember-rule] input[aria-label="Merchant words to match"]')).toHaveValue('cabelas');
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('"cabelas" will go to Shopping')).toBeVisible();
  const rules = await page.evaluate(() => FinanceDB.getSetting('categoryRules'));
  expect(rules).toEqual([expect.objectContaining({ match: 'cabelas', category: 'Shopping', sign: 'out' })]);
});

test('settings shows the running version', async ({ page }) => {
  await page.locator('nav').getByText('Settings').click();
  await expect(page.locator('[data-testid=app-version]')).toContainText(/Centric Wealth v\d+\.\d+\.\d+ · statement reader v\d/);
});

test('sheets open over the whole screen, outside any glass card', async ({ page }) => {
  await page.getByRole('button', { name: 'Try sample' }).click();
  await expect(page.getByRole('button', { name: 'Net Worth' })).toBeVisible();
  await page.getByRole('button', { name: 'Quick Log Entry' }).click();
  const dlg = page.locator('[role=dialog]');
  await expect(dlg).toBeVisible();
  // Portalled to <body>: a backdrop-filter or transform on a card would otherwise shrink the fixed overlay to that card.
  expect(await dlg.evaluate((el) => el.parentElement === document.body)).toBe(true);
  const box = await dlg.boundingBox();
  expect(box.width).toBe(390);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});

test('analytics steps through months, quarters, half-years and years', async ({ page }) => {
  // Calendar periods, worked out the same way the app does (quarters from Jan/Apr/Jul/Oct, halves from Jan/Jul).
  const p = await page.evaluate(() => {
    const T = new Date(2026, 9, 22);
    const show = (t, o) => { const x = Analytics.period(t, o, T); return [x.label, x.start, x.end, x.buckets.length]; };
    return { m: show('month', 0), m1: show('month', -1), q: show('quarter', 0), q1: show('quarter', -1), h: show('half', 0), h1: show('half', -1), y1: show('year', -1),
      jump: Analytics.periodOffsetFor('month', '2026-06', T), qOf: Analytics.periodOffsetFor('quarter', '2026-05', T) };
  });
  expect(p.m).toEqual(['October 2026', '2026-10-01', '2026-10-31', 4]);        // weeks 1-7, 8-14, 15-21, 22-31
  expect(p.m1).toEqual(['September 2026', '2026-09-01', '2026-09-30', 4]);
  expect(p.q).toEqual(['Q4 2026', '2026-10-01', '2026-12-31', 1]);             // only months that have started
  expect(p.q1).toEqual(['Q3 2026', '2026-07-01', '2026-09-30', 3]);
  expect(p.h).toEqual(['H2 2026', '2026-07-01', '2026-12-31', 4]);
  expect(p.h1).toEqual(['H1 2026', '2026-01-01', '2026-06-30', 6]);
  expect(p.y1).toEqual(['2025', '2025-01-01', '2025-12-31', 12]);
  expect([p.jump, p.qOf]).toEqual([-4, -2]);

  await page.getByRole('button', { name: 'Try sample' }).click();
  await page.getByRole('button', { name: 'Analytics' }).first().click();
  const label = page.locator('[data-testid=period-label]');
  const now = new Date(), MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  await expect(label).toHaveText(`${MON[now.getMonth()]} ${now.getFullYear()}`);
  await expect(page.getByRole('button', { name: 'Next month' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous month' }).click();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  await expect(label).toHaveText(`${MON[prev.getMonth()]} ${prev.getFullYear()}`);
  await page.getByRole('button', { name: 'Quarter', exact: true }).click();
  await expect(label).toHaveText(`Q${Math.floor(prev.getMonth() / 3) + 1} ${prev.getFullYear()}`); // keeps your place
  await page.getByRole('button', { name: 'Half-year', exact: true }).click();
  await expect(label).toHaveText(`H${prev.getMonth() < 6 ? 1 : 2} ${prev.getFullYear()}`);
  await page.getByRole('button', { name: 'Year', exact: true }).click();
  await expect(label).toHaveText(String(prev.getFullYear()));
  await expect(page.locator('[data-testid=period-totals]')).toContainText('Income');
});
