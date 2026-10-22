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
