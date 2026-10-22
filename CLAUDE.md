# Centric Wealth — project guide for Claude Code

Centric Wealth is a privacy-first, offline-first personal finance PWA. It runs entirely in the browser: no backend, no accounts, no analytics, no API keys. All data lives in the user's IndexedDB. It is hosted on **GitHub Pages**. The owner deploys by uploading changed files to the repo; there is **no build step**. The files in this folder are the site.

The owner is building it for himself. He uses US banks and cards (PNC checking, a Zolve Mastercard), works mostly on his phone, and is in Florida (America/New_York).

## Golden rules

1. **Privacy:** never add a server, external API, analytics, tracking, or anything that sends the user's data off the device. Network use is limited to the pinned CDN libraries (and their offline cache). The Content-Security-Policy `<meta>` at the top of `index.html` enforces this; a new CDN host must be added there, and `tests/security.spec.mjs` checks every request.
2. **No build step:** keep it static. Single-page `index.html` with React 18 UMD + Babel standalone (`<script type="text/babel">`), Tailwind Play CDN, Lucide UMD. Plain-script modules attach to `window`.
3. **ASCII only in `.js` files:** use `\uXXXX` escapes for anything non-ASCII (bullets, dashes, currency symbols). GitHub Pages / some browsers have mis-decoded UTF-8 in these files before. `index.html` may contain UTF-8. Check with:
   `python3 -c "import sys;[print(f) for f in sys.argv[1:] if any(ord(c)>127 for c in open(f).read())]" *.js`
4. **Release checklist (every deploy):** bump all three together, then update README.md.
   - `VERSION` in `sw.js` (e.g. `'v1.15.0'`)
   - `APP_VERSION` in `index.html`
   - the `?v=1.15.0` query on the five `<script src="./*.js?v=…">` tags in `index.html`

   Also bump `StatementParser.version` (bottom of `statement-parser.js`) when the parser changes; Settings shows it.
5. **Real statements never get committed.** `tests/private/` is git-ignored. The site is public, so remember that drag-and-drop uploads on github.com ignore `.gitignore`.
6. **Run the tests** (`npm test`) before saying a change is done. Add or extend a test for every bug fix, especially parser fixes.
7. **When finishing a change, tell the owner exactly which files to replace or add on GitHub,** and the new version number.

## Run and test locally

```bash
npm install                       # installs @playwright/test only
npx playwright install chromium   # first time
npm run serve                     # http://127.0.0.1:4173/  (no-cache static server, tests/serve.mjs)
npm test                          # all tests (parser + app), phone-sized Chromium, service workers blocked
npm run test:parser               # just the statement parser
npm run test:app                  # just the end-to-end app smoke tests
```

- Tests load CDN libraries from the internet, the same as production.
- If Playwright's own Chromium is unavailable, set `CHROMIUM_PATH=/path/to/chrome`.
- Real statements for regression tests go in `tests/private/`: `zolve.pdf` (Zolve card, Sep 18–Oct 17 2026) and `pnc.pdf` (PNC Virtual Wallet, Sep 26–Oct 25 2023). Their tests skip when the files are absent.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole UI (~3,300 lines): `FinanceDB` IndexedDB wrapper, React app, design tokens/CSS, all screens |
| `statement-parser.js` | `window.StatementParser`: PDF (pdf.js 4.10.38 legacy) and CSV (PapaParse 5.5.3) statement reading, cleaning, categorisation, recurring detection, saving |
| `recurring-scanner.js` | `window.RecurringScanner`: subscription/bill detection, Keep/Cancel decisions, reminder schedule and notifications, `billStatus`, `cardDueStatus` |
| `advisor-engine.js` | `window.AdvisorEngine`: health score A+…F, 50/30/20, debt payoff (avalanche/snowball) |
| `analytics-engine.js` | `window.Analytics`: monthly aggregates, credit-card utilization, cash-flow series, savings funds, Chart.js 4.5.1 configs (animations, glass tooltips, glow/reveal plugins), PDF chart images |
| `monthly-report.js` | `window.MonthlyReport`: monthly report as PDF (jsPDF 4.2.1 + autotable 5.0.9), Markdown or text |
| `sw.js` | Service worker. Own files are network-first (`cache:'no-cache'`), with the cache as offline fallback. Pinned CDN files are cache-first. Periodic-sync reminders. The page reloads once on `controllerchange` |
| `manifest.webmanifest`, `icon*.png`, `icon.svg` | PWA install metadata and icons |
| `fonts/manrope-latin-var.woff2` | Self-hosted Manrope variable font (OFL, `fonts/OFL-Manrope.txt`); no Google Fonts, for privacy |
| `tests/` | Playwright tests, synthetic fixtures (`tests/fixtures/`), static server, parser harness page |
| `README.md` | User-facing docs for every feature (keep it updated) |

## Data model (IndexedDB `centric-wealth`, version 1)

Stores: `transactions`, `debts`, `bills`, `budgets`, `accounts`, `settings` (key/value). `window.FinanceDB` (also `DB` in the code) has `getAll`, `get`, `count`, `put`, `bulkPut`, `delete`, `clear`, `byIndex`, `getSetting`/`setSetting`, `exportAll`/`importAll` (JSON backup, validated by `validateBackup`), `wipe` (empty stores) and `destroy` (delete the database + `cw.*` local/session keys). React code should use the context helpers `save`/`remove`/`reload`, which also refresh state.

- **Backends:** IndexedDB; if it's blocked, a `localStorage` copy (`cw.db.v1`), else memory only. `FinanceDB.backend` tells which. The service worker's background reminders need IndexedDB.
- **Every write is cleaned** (`cleanText`/`cleanValue`: control, zero-width and bidi-override characters removed, lengths capped, `__proto__` keys dropped). Never render user text as HTML (no `dangerouslySetInnerHTML`/`innerHTML`).
- **`window.SecureVault`** (inline script after FinanceDB): `encryptBackup`/`decryptBackup` (AES-256-GCM, PBKDF2-SHA-256 600k), `hashPin`/`checkPin` (PBKDF2 310k), `registerDevice`/`verifyDevice` (WebAuthn platform authenticator, verified locally incl. signature).

- **Transaction:** `{ id, date 'YYYY-MM-DD', amount (always positive), type: 'income'|'expense'|'transfer', direction: 'in'|'out', category, description, accountType: 'bank'|'credit'|'cash'|'fund'|null, accountName, hash, source: 'statement'|'quick-log'|'manual'|'savings'|'sample'|'debt', createdAt, statementCategory?, counterparty?, purpose?, entryKind?, debtId? }`
  - `hash` is `date|amount|lower(description)`, used to de-duplicate within the same account. The nth identical row gets the suffix `#n`.
  - **Transfers are excluded from income and expense totals**: card payments, moves between own accounts, Zelle, wires, fund moves and lending.
- **accounts store:**
  - bank accounts: `kind:'bank'`, `type` Checking/Savings;
  - Cash Wallet: `kind:'cash'`;
  - savings funds: `kind:'fund'`, `type:'Savings'`, `fundType:'emergency'|'goal'`, `targetMode`, `targetMonths`, `target`, `targetDate`, `color`, `icon`.
- **debts store:** credit cards are `kind:'credit'`/`type:'Credit Card'`, with `creditLimit, apr, minPayment, last4, dueDay (1-31), dueSince, lastPaid, reminders, remindDays, color`. Loans are the other debt types.
- **Ledger balances:** `ledger:true` accounts compute `balance = anchorBalance + effects of tagged transactions after anchorDate`.
  - Same-day transactions count only if `createdAt > anchorSetAt`.
  - `balanceSource` is `'statement'|'manual'|'estimated'`.
  - Statement imports set the anchor from the statement's ending balance (newest statement wins).
- **Settings keys:**
  - preferences: `currency`, `theme` (`system|light|dark`), `notify`, `reminderDays`;
  - debt planner: `debtExtra`, `debtStrategy`;
  - `lastBackup`;
  - `categoryRules` (`[{match, category, sign:'in'|'out', type, createdAt}]`);
  - recurring/reminders: `recurringDecisions`, `reminderSchedule`, `notificationLog`;
  - privacy & lock: `privacy` (bool), `lock` (`{enabled, salt, iterations, hash, pinLength, minutes, onHide, device:{id, publicKey, alg}}`) and `lockFails` (`{n, until}`). `lock`/`lockFails` are device-only: never exported or restored.

## Statement parser pipeline (`statement-parser.js`)

1. **`sniffType`**: PDF, CSV, or a clear error (`UNSUPPORTED_TYPE`, `EMPTY_FILE`, `PDF_PASSWORD`, `PDF_NO_TEXT`, `NO_TRANSACTIONS`, `CSV_INVALID`).
2. **PDF:** `extractPdfLines` (pdf.js text items grouped into lines; column gaps become 3 spaces), then `parsePdfLines`:
   - rows start with a date. The amount is at the end (`TRAILING_MONEY`), or right after the date (`LEADING_MONEY`/`LEADING_CENTS`, PNC style);
   - the sign comes from the explicit sign / CR / DR, the running-balance arithmetic, then **section headings** (`IN_SECTION`, `OUT_SECTION`, `CC_OUT_SECTION`, the loose variants, and `STOP_SECTION` for daily-balance tables);
   - wrapped description lines are joined for amount-first rows; side-column text is stripped (`SIDE_TEXT`);
   - card statements: `cardSummary()` reads previous balance, minimum due, payment due date, APR, last 4, and interest/fees totals. Period interest with no dated line becomes one synthetic charge on the closing date;
   - bank statements: `bankSummary()` reads Beginning | Deposits | Deductions | Ending tables;
   - both produce `meta.reconciliation` (`ok` when previous + charges − credits = new balance). A mismatch adds a `BALANCE_MISMATCH` warning, shown in the Upload preview by `StatementCheck`.
3. **CSV:** header detection, column mapping (date/description/amount or debit/credit/type/category/balance), and amount-sign inference for card CSVs.
4. **Categorise:**
   - `matchCustomRule` (user rules) comes first;
   - then `categorize`: `normalizeText` (lowercase, every non-letter becomes a space) and whole-word keyword rules in **order** (Transfers, Income, Refunds, Dining, Transport, Utilities, Apple-Store→Shopping, Subscriptions, Groceries, Government & Taxes, Housing, …);
   - BNPL prefixes (`KLARNA*`) are categorised by the merchant after the prefix;
   - no match gives `'Uncategorized'` (money in gives `'Income'`).
5. **Bank payments to a credit card** (`isCardPaymentOut`: card issuers plus the distinctive words of the user's card names passed as `cardNames`) become `Card Payment` transfers.
6. **Recurring detection**, then **`classify(t, accountType)`** maps parser categories to the app's types and categories (`APP_CATEGORY`, `toAppCategory`).
7. **`saveTransactions`** de-duplicates per account and stores the rows. The app imports through `importStatement()` in `index.html`, which also sets the balance anchor and fills card details (last4, APR, minimum, limit, due day).

**To support a new statement layout:**
1. Dump its lines with `await StatementParser._extractPdfLines(file)` (in the browser console or the harness).
2. Make the smallest general rule change.
3. Make sure the statement reconciles.
4. Add the file (synthetic) to `tests/fixtures/`, or (real) to `tests/private/`, with a test.
5. Run the whole parser suite: every fixture must keep its count.

App category lists live in `index.html`: `EXPENSE_CATEGORIES` (includes `Government & Taxes`, `Fees & Interest`, `Uncategorized`), `INCOME_CATEGORIES` and `TRANSFER_CATEGORIES`. The advisor's needs/wants sets are in `advisor-engine.js`.

## UI architecture (`index.html`)

- **App shell:** `App` holds the tab state (`#hash` routing: `dashboard`, `transactions` labelled "Activity", `upload`, `budget/<sub>`, `advisor`, `settings`), theme, ledger recalculation, recurring analysis, reminder sync and the toast. It renders the floating glass nav dock, `QuickLogFab`, `ManageCardsSheet` and `Toast`.
- **Context:** `useApp()` provides `data, save, remove, reload(store|[stores]), setSetting, fmt(n, short), toast(msg, 'ok'|'error'), go(tab, sub), loadSample, openCards(state), markCardPaid, recurring, recurringAction`.
- **Primitives:** `Card` (`.card`), `SectionTitle` (sentence case, no uppercase eyebrows), `Button` (primary/secondary/danger/ghost, `.press`), `Field`, `Input`, `Select`, `Segmented` (sliding pill), `Progress`, `GrowBar`/`GrowBarRaw`, `Disclosure` (animated accordion), `Sheet` (spring bottom sheet, drag-to-dismiss, exit animation), `Toast` (top), `Empty`, `SkeletonScreen`, `AnimatedMoney`/`useAnimatedNumber` (count-ups), `LiquidGauge`, `ChartBox` (lazy Chart.js), `NumbersTable`.
- **Screens:**
  - Dashboard: hero net balance, summary cards, `CardDueTracker`, cash flow, `SavingsSection`, `RecurringCard`, due soon, spending, `MonthlyReportCard`, recent. Its Analytics switch shows `AnalyticsView`.
  - `Transactions`: filters, the "Needs category" chip, `TxForm` with "Remember for future imports".
  - `UploadView`: single-file preview, or `BatchList` for multiple files.
  - `BudgetDebt` (Budget / Debt / Bills / Assets), `AdvisorView`, `SettingsView` (including `CategoryRules`).
- **Design system:**
  - CSS variables on `:root` / `:root.dark` (`--canvas`, `--card`, `--glass`, `--sheet`…);
  - Manrope; emerald brand (`brand-*`) on a cool mist (light) or deep navy (dark) canvas;
  - real `backdrop-filter` only on the nav, sheets and toasts;
  - the hero is the one bold element;
  - motion: `.stagger` page entry, `.rise-list`, `.press` and `.lift`; everything is disabled under `prefers-reduced-motion`.
- **Charts** (dataviz palette, validated): light `#2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #008300 #6250d6 #e34948`, dark `#3987e5 #d95926 #199e70 #c98500 #d55181 #008300 #9085e9 #e66767`.
  - Status colors are good `#0ca30c`, warning `#fab219`, serious `#ec835a`, critical `#d03b3b`. Always pair them with an icon and a label.
  - No dual axes; at most 6 doughnut segments; give each chart a "Show numbers" table.
- **Storage:** use IndexedDB for anything that matters; `sessionStorage`/`localStorage` only for small UI conveniences, wrapped in try/catch.

## Decisions already made (don't undo without asking)

- **Google Workspace integration:** built, then **reverted at the owner's request**. Don't re-add Google/OAuth or any cloud sync.
- **Report downloads:** the monthly report is generated client-side (PDF/MD/TXT); no backend.
- **Transfers, not income or spending:**
  - Zelle (including PNC's "Zel To/From"), wires, and transfers between own accounts. The owner can recategorize them, and rules remember it.
  - Card payments from the bank. Spending is counted on the card.
- **Category assignments:**
  - Walmart and Target count as **Groceries**.
  - Xfinity and Comcast count as **Subscriptions**.
  - Any Apple charge except the Apple Store counts as Subscriptions.
  - USCIS/IRS/DMV go to **Government & Taxes**; interest goes to **Fees & Interest**.
- **Uncategorized:** unmatched spending is stored as `'Uncategorized'` (not `'Other'`) so it can be reviewed.
- **Privacy mode masks through `fmt`:** all on-screen money must go through `fmt` from `useApp()` (it returns `$••••••` in privacy mode); card digits through `mask4(privacy, last4)`. Exports (reports, CSV, backups) are never masked.
- **App lock** hides the app (overlay + everything else `inert`), it doesn't encrypt storage; the README says so. Don't lock on window `blur` (file pickers and the Face ID prompt cause it); lock on `visibilitychange` only.
- **Credit card due dates:** due day of month 1–31 (29–31 fall on the last day in short months).
  - Badges: green above 7 days or paid; yellow within 7 days; **pulsing red** within 3 days or overdue.
  - "Mark paid" sets `lastPaid` and doesn't change the balance.

## Ideas not built yet

- Split transactions; editing categories from the Upload preview before importing.
- CSV/Excel export of transactions.
- Budget roll-over and per-account budgets.
- More statement layouts as the owner sends them (Chase, Bank of America, Discover PDFs…).
