# Centric Wealth — private, offline-first finance PWA

Everything runs in the browser. Data lives in IndexedDB on the device; there are no servers, accounts, analytics or API keys.

## Files

Developing with Claude Code? Start with **CLAUDE.md** (architecture, rules, release checklist) and run `npm install && npx playwright install chromium && npm test`.

| File | Purpose |
|---|---|
| `index.html` | The whole app: FinanceDB (IndexedDB wrapper) + React UI |
| `sw.js` | Service worker — caches the app and pinned CDN libraries for offline use |
| `manifest.webmanifest` | Makes it installable ("Add to Home Screen") |
| `statement-parser.js` | PDF/CSV statement import, categorisation and recurring detection |
| `recurring-scanner.js` | Subscription & bill detection, Keep/Cancel decisions, reminders |
| `advisor-engine.js` | Health score, 50/30/20 budget and debt payoff maths for the Advisor tab |
| `monthly-report.js` | Monthly report as PDF, Markdown or text |
| `analytics-engine.js` | Analytics calculations, Chart.js chart setups, savings funds |
| `fonts/manrope-latin-var.woff2` | Manrope variable font, served from your own site (no font CDN). License: `fonts/OFL-Manrope.txt` |
| `icon*.png`, `icon.svg` | App icons |

## Deploy to GitHub Pages
1. Create a repo and push these files to the root of `main`.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main` / `(root)`.
3. Open `https://<user>.github.io/<repo>/`. Load it once online; after that it works offline.

All paths are relative, so it works from a repo sub-path.

## Updating
Bump `VERSION` in `sw.js` on every deploy so returning visitors get the new files.


**After every deploy**, bump three things together: `VERSION` in `sw.js`, `APP_VERSION` in `index.html`, and the `?v=` on the `<script>` tags. Open copies then pick up the new files automatically: the service worker fetches the app's own files from the network first and reloads the page once when the new version takes over. Settings shows the running version at the bottom ("Centric Wealth v1.17.0 · statement reader v1.4.0"). Offline, the saved copies are used.
## Using FinanceDB elsewhere
```js
await FinanceDB.put('transactions', { type: 'expense', amount: 12.5, category: 'Dining', date: '2026-10-21', description: 'Lunch' });
const oct = await FinanceDB.byIndex('transactions', 'date', '2026-10-01', '2026-10-31');
const backup = await FinanceDB.exportAll();
```
Stores: `transactions`, `debts`, `bills`, `budgets`, `accounts`, `settings`. To add a store or index, edit `SCHEMA` and bump `DB_VERSION`.

## Production notes
- In-browser Babel compiles the JSX on every launch (~0.3–1 s on phones). For speed, precompile the `text/babel` script once with Babel and swap in the output.
- The Tailwind Play CDN is meant for prototyping; for production, build a static CSS file with the Tailwind CLI.
- Bill reminders fire when the app is opened or brought to the foreground. True background push needs a push server, which this app deliberately doesn't use.
- Browsers can evict site storage. Use **Settings → Persistent storage** and make regular JSON backups.

## Statement parser (`statement-parser.js`)
Reads bank and credit-card statements (PDF or CSV) in the browser, categorises them with a local rule dictionary, flags recurring charges and saves them into the app's IndexedDB. No server or API keys.

```html
<script src="./statement-parser.js"></script>
<script>
  const txs = await StatementParser.parseStatement(file);
  // [{ date: '2026-10-02', description: 'WHOLE FOODS MKT', amount: -84.2, category: 'Groceries', isRecurring: false }]
</script>
```
- `amount` < 0 is money out, > 0 is money in.
- `parseStatementDetailed(file)` also returns `recurring` (cadence, monthly cost, review reasons such as price increases or possible double billing), `warnings` (skipped rows with row numbers) and `saved` counts.
- Options: `persist`, `password` (locked PDFs), `dateOrder` ('MDY'/'DMY'), `statementType`, `invertAmounts`, `customRules`, `onProgress`, `onWarning`.
- Errors carry a `code` (e.g. `PDF_PASSWORD`, `PDF_NO_TEXT`, `CSV_INVALID`, `NO_TRANSACTIONS`).
- Edit categories in `RULES`, or call `StatementParser.setRules([...])`.
- Scanned (image-only) PDFs need OCR and are rejected with `PDF_NO_TEXT`; use the bank's CSV export instead.

## Subscriptions & bills (`recurring-scanner.js`)
Scans saved transactions for repeating charges. Everything is rule-based and runs on the device.

- **Detection:** groups charges by a normalised merchant name ("NETFLIX.COM 866-579 CA" becomes "NETFLIX"), clusters similar amounts, and checks the timing (weekly through yearly). Utility bills may vary by about 40% month to month. Everyday merchants (cafés, fuel, groceries) only count with 4+ identical charges on a consistent day.
- **Review flags:** price increase, charged twice, trial converted to a paid plan, no recent charge, and charged after you marked it cancelled.
- **Dashboard card:** each item has **Keep** and **Mark as Cancelled**. Keep adds monthly and yearly items to Bills so they get due dates. Imported charges then mark those bills as paid automatically.
- **Reminders** (Settings → Bill & subscription reminders) arrive:
  - when the app is opened or brought back to the screen, on all platforms;
  - in the background about once a day on Android, when the app is installed in Chrome;
  - on iPhone and iPad, only after **Add to Home Screen** (iOS 16.4+), and then only while the app is opened.
  The web has no way to schedule a notification for an exact future time without a push server. This app deliberately has no push server.

## Budget & Health Advisor (`advisor-engine.js`)
Everything is calculated on the device from IndexedDB data using standard formulas.

- **Averages:** monthly figures average the last 3 complete months that have data, so a half-finished month doesn't skew them. Transfers are excluded.
- **Health grade (A+ to F)** is made up of six factors, 100 points in total:
  - savings rate: 25 points, full marks at 20% or more;
  - debt-to-income: 20 points;
  - emergency fund in months of essentials: 20 points;
  - high-interest debt above 15% APR: 15 points;
  - essentials share of income: 10 points;
  - budgets on track: 10 points.

  Spending more than you earn caps the grade at C, and a debt-to-income ratio above 50% caps it at D.
- **50/30/20:** Needs, Wants and Savings targets are set from your actual income. Debt payments above the minimum count toward savings.
- **Debt paydown:** a month-by-month simulation of avalanche (highest APR first) and snowball (smallest balance first) with rollover. It shows the payoff order, total interest and the debt-free date, and recommends the cheaper method. The Budget & Debt tab uses the same engine.

Educational estimates, not financial advice.

## Bank vs credit card statements
On **Upload**, choose **Bank Statement** or **Credit Card Statement** and, optionally, give the account a label such as "Chase Checking" or "Amex Gold". Every imported transaction is saved with `accountType: 'bank' | 'credit'` and `accountName`.

| | Bank statement | Credit card statement |
|---|---|---|
| Money in | Income (deposits) | **Balance adjustment** (payment, refund or statement credit) that lowers the amount owed; not income |
| Money out | Expense (withdrawals) | Expense (charge) that raises the amount owed |
| Card payment / own-account move | Transfer, not spending | Transfer |

A card payment appears on both statements. Both copies are stored as transfers, so the money is only counted once, as the card charges.

**Balances**
- Bank accounts are stored with Assets and credit cards with Debts, so net worth, the payoff planner and the Advisor include them.
- An imported account's balance starts from the statement's ending balance ("New Balance" for cards). It is read from PDFs and from CSV balance columns, or you can type it. Newer transactions are then added on top.
- If no balance is known, it is estimated from transactions and labelled as an estimate.

**Dashboard:** shows Bank Balance (liquid cash), Credit Card Owed, and Combined Net Balance (bank minus cards). It also has a **Spending by account** card with All / Bank Accounts / Credit Cards tabs.

**Activity:** the transaction list has the same three tabs.

## Monthly report: PDF, Markdown or text (`monthly-report.js`)
The **Dashboard** has a **Monthly report** card. Pick a month, choose **PDF**, **Markdown** or **Text**, then tap **Download PDF Report** (or **Download Monthly Report** for the other formats). The file is built on the device and saved straight to Downloads, e.g. `Financial_Report_October_2026.pdf`. No server or API is involved.

### What the PDF contains
- **Summary cards:** Total Bank Balances (including the cash wallet), Credit Card Debt, Net Balance, Monthly Income, Monthly Expenses, and Net Cash Flow.
- **Balances by account.**
- **Category Breakdown:** a stacked bar chart split into card, bank and cash spending, plus a table.
- **Flagged Subscriptions & Recurring Payments:** each payment's billing cycle, last charge, next due date, monthly cost, and flags such as price increases.
- **Cash & Transfer Logs:**
  - totals for cash spent, cash received, money sent and money received;
  - every Quick Log entry for the month;
  - who still owes whom from money lent or borrowed.

### How it works
- The PDF uses **jsPDF 4.2.1** and **jsPDF-AutoTable 5.0.9** from jsDelivr. The service worker caches both (about 450 KB), so PDF reports work offline after the app has been installed or opened once online.
- `MonthlyReport.downloadPdf(data, 'YYYY-MM')` creates the PDF.
- `MonthlyReport.download(data, 'YYYY-MM', 'md' | 'txt')` creates the Markdown or text versions.
- **Share / Save to Files** appears on phones that support sharing files, notably iPhone.

## Quick Log: cash and money transfers
The **Quick Log** button floats on the Dashboard and Activity screens. Use it for anything that isn't on a statement.

| Field | Options |
|---|---|
| Transaction type | Cash Expense, Cash Income, Money Sent (Transfer), Money Received |
| Account / source | Cash Wallet, Bank Account, Credit Card |
| Details | Amount, date, category, notes; for transfers, the person and what it was for |

**How entries count:**

| Entry | Counts as |
|---|---|
| Cash expense, paying someone, gift sent | Spending |
| Cash income, someone paying you, gift received | Income |
| Lending, borrowing, repayments, moves between your own accounts | Balance change only, tracked as who owes whom |

**Where entries go:**
- Entries are saved in IndexedDB with the statement transactions, tagged `source: 'quick-log'`, `entryKind`, `accountType` (`cash`, `bank` or `credit`) and `counterparty`.
- They flow into budgets, the Advisor, the Dashboard totals and every report format.
- The first cash entry creates a **Cash Wallet** account, with an optional starting amount. Its balance counts as liquid cash.
- In Activity, the **Cash & transfer log only** filter shows just these entries.

## Analytics dashboard (`analytics-engine.js`, Chart.js 4.5.1)
On the **Dashboard**, switch **Overview / Analytics**, then pick **Month**, **Quarter**, **Half-year** or **Year** and use the ‹ › arrows to step through calendar periods (for example *October 2026*, *Q3 2026* = Jul–Sep, *H1 2026* = Jan–Jun, *2025*).

- **Breakdown:** a month is charted week by week (1–7, 8–14, 15–21, 22–end); quarters, half-years and years month by month. A period that is still running shows only the weeks or months that have started, marked "to date".
- **Compared with the period before:** income and spending show the change from the previous period (green when it's good news, red when it isn't). While a period is still running it's compared with the same point in the previous one, so the first half of October is measured against the first half of September, not all of it.
- **Every chart follows the period:** income vs. expenses, card spending and debt, spending by category, the savings rate for the period (with a month-by-month trend for quarters and longer) and the bank & cash balance (daily for a month or quarter, weekly for longer). Debt-to-income uses your recent average, so it doesn't change with the period.
- **Keeps your place:** switching from *Q2 2026* to Month shows June 2026; the chosen view is remembered while the app is open. The back arrow stops at your oldest transaction.

| Chart | Shows |
|---|---|
| Income vs. expenses | Income bars next to expenses, stacked by credit cards, bank outflows and cash |
| Credit cards | **Spending:** monthly charges per card. **Utilization:** owed vs. credit limit, with a 30% guideline. **Debt:** amount owed at each month end, rebuilt from today's balance and statement history |
| Spending by category | A doughnut of the top 5 categories plus "Other", with a value list |
| Savings rate | A gauge for the latest month, plus a monthly trend |
| Debt-to-income | A meter with the 20% / 36% / 43% zones |
| Bank & cash balance | The combined balance of bank accounts and the cash wallet over time |

**Design and accessibility:**
- **Palette:** colors follow a validated colorblind-safe palette in a fixed order.
- **No dual-axis charts:** different measures are always drawn as separate charts.
- **Status labels:** good / warning / critical always comes with an icon and text, never color alone.
- **Exact values:** every chart has **Show numbers** for the underlying figures.
- **Offline:** Chart.js loads from jsDelivr only when charts are shown, and the service worker caches it for offline use.

Credit limits come from card statements ("Credit Limit"), or you can enter them in Budget → Debt.

## Savings & Emergency Fund
- **Where:** Dashboard → Overview → **Savings & emergency fund**.
- **Emergency fund target:** a number of months of essential spending (default 3; the Advisor works out the monthly figure) or a fixed amount.
- **Goals:** any number of goals (e.g. Vacation Fund) with an amount, an optional date ("save $X/month to reach it on time"), and a color and icon.
- **Add Funds / Withdraw Funds:** can move money from or to a bank account or the cash wallet. That's recorded as a transfer on both sides, so net worth doesn't change. "Not tracked here" is for a fund kept in a separate savings account.
- **Animations:** savings are drawn in neon blue. The emergency fund has a liquid-fill gauge with waves and rising bubbles; goal bars are liquid fills with drifting ripples, a light sweep and a glowing leading edge, and they surge brighter when you add funds. Numbers count up, and a floating "+$X" with a glow appears on deposits. All animation is turned off when the phone's Reduce Motion setting is on.
- **Storage:** funds are accounts with `kind: 'fund'`, and deposits and withdrawals are `transfer` transactions with `accountType: 'fund'`. They count in net worth and in the Advisor's emergency-fund score.
- **Reports:** funds appear in the balances, a Savings & Emergency Fund section, and the Markdown and text reports.
- **PDF chart summary:** the PDF also gets a **Chart Summary** page, with the charts drawn on the device as images.


## Bank statements with "Date | Amount | Description" (PNC and similar)

Some banks print the amount *before* the description and group rows under headings instead of signing them. Examples are PNC Virtual Wallet and many credit unions. The parser handles them as follows:
- **Signs:** "Deposits and Other Additions" rows count as money in. "…Withdrawals and Purchases" and "…Deductions" rows count as money out.
- **Wrapped lines:** descriptions that wrap onto the next line ("Delray Beach" / "Fl") are joined. Text from the side column ("There were 7 Deposits… totaling $…") is dropped.
- **Daily balance table:** the "Daily Balance Detail" table is ignored, not read as transactions.
- **Short amounts and missing years:** amounts like `.59` read as $0.59, and dates without a year take it from the statement period.
- **Balance check:** the summary table (Beginning | Deposits | Deductions | Ending) is read. The preview checks beginning + deposits − withdrawals = ending.
- **Transfers:** Zelle (including PNC's "Zel To/From"), wires and transfers between your own accounts are transfers. Payments to a credit card are **Card Payments**: the parser recognises common issuers (Zolve, Amex, Discover, Capital One…) and the names of cards you've already added.

## Card statements that print every amount without a sign

Some issuers (for example Zolve) print every amount as a positive number. They put payments under **Payments & Other Credits** and purchases under **Transactions**. The parser reads these section headings to decide the sign. It also:
- **Adds interest and fees** that appear only as period totals ("Interest Charged $31.76") as one charge on the closing date, unless a dated line already covers them.
- **Checks the arithmetic:** previous balance + charges − payments/credits must equal the new balance. The preview shows "Adds up ✓", or a warning when it doesn't.
- **Reads card details** (last 4 digits, payment due date, minimum due, purchase APR, credit limit) and saves any that are missing to the card. The newest statement keeps the minimum, APR and limit current.
- **New categories:** **Government & Taxes** (USCIS, IRS, passport, DMV…) and **Fees & Interest**. Buy-now-pay-later charges ("KLARNA* MERCHANT") are categorized by the merchant after the prefix.

## Uploading several statements at once

- On **Upload**, pick or drop several PDF/CSV files together (for example a year of monthly statements, or a bank and a card statement).
- **Reading:** each file is read on the device, one at a time, and listed with its date range, how many transactions are new, how many were already imported, how many are uncategorized, and the balance found on the statement.
- **Accounts:** every file starts with the type and account from steps 1-2. Tap the account chip on a file to make it a bank account or credit card, or to send it to a different account (existing or new).
- **Problems:** a password-protected PDF gets its own password box. Files that aren't statements show why, and you can remove them with ×.
- **Import:** one button imports everything, oldest statement first. Each account's balance comes from its latest statement. Overlapping statements and files imported before don't create duplicates.
- **Single files:** picking one file keeps the original single-statement preview, where you can edit the balance by hand.

## Categories: cleaning, keywords and your own rules

- **Cleaning before matching:** each description is lower-cased and every digit, store number and symbol becomes a space, then spaces collapse (`StatementParser.normalizeText`). For example, `PUBLIX #1234 TAMPA FL` becomes `publix tampa fl`, `UBER *TRIP` becomes `uber trip`, and `APPLE.COM/BILL` becomes `apple com bill`. Keywords are cleaned the same way, so `at&t` matches `AT&T*BILL` and `trader joe's` matches `TRADER JOE'S #552`. Matching is on whole words, so `cab` doesn't match `CABELAS`.
- **Built-in dictionary** (`RULES` in `statement-parser.js`; the first match wins):
  - **Groceries:** Publix, Walmart (also `WAL-MART` and `WM SUPERCENTER`), Target, Trader Joe's, Whole Foods, ALDI, Winn-Dixie.
  - **Transport:** Uber, Lyft, Shell, Chevron, Exxon, Wawa, other gas stations, and transit.
  - **Subscriptions:** Apple, iTunes, iCloud, Xfinity, Comcast, Netflix, Spotify, Hulu, Amazon Prime and Google.
  - **Dining:** Starbucks, McDonald's, Chipotle, Uber Eats, DoorDash and Grubhub.
  - **Utilities:** electric, water and gas bills, FPL, Verizon, T-Mobile and AT&T.
- **Rule order:** rules are checked in an order that resolves overlaps. Uber Eats is checked before Uber, gas stations before the gas bill, and Apple Store (Shopping) before Apple (Subscriptions).
- **No match:** spending gets **Uncategorized**. The import preview says how many rows weren't matched. In Activity, a **Needs category (N)** chip lists every uncategorized transaction across all months.
- **Recategorizing:** tap a transaction and pick a category. You can then:
  - choose **Remember for future imports**, with the merchant words pre-filled and editable (for example `cabelas`);
  - optionally move the other matching transactions to the same category in one go.
- **Your rules:** rules are saved in IndexedDB (`settings` › `categoryRules`) and checked before the built-in dictionary on every import. View, add or delete them in **Settings › Category rules**. A rule added there also fixes matching Uncategorized transactions.

## Credit cards & payment due dates

- **Manage credit cards** (Dashboard › Credit card due dates › Manage, Settings, or Budget & Debt › Debt): add, edit or delete cards with a name, last 4 digits, credit limit, balance, APR, minimum payment, color and a **payment due day** (tap a day 1-31 on the picker; 29-31 fall on the last day in shorter months). Change it any time. Only the last 4 digits are stored, never a full number.
- **Dashboard tracker:** each card shows its balance, limit, utilization bar and due date, most urgent first. Badges always pair color with an icon and text:
  - green: due in more than 7 days, or paid for this cycle;
  - yellow: due within 7 days;
  - pulsing red: due within 3 days, today, or overdue.
- **Paid detection:** a card counts as paid for the cycle when a payment lands after the previous due date (an imported "Card Payment", a payment logged in the Debt tab, or the **Mark paid** button, which only stops reminders and doesn't change the balance; undo it from the card's edit screen). Cards with no balance show "Nothing owed".
- **Reminders:** with notifications on in Settings, each card gets a heads-up before the due date (the app setting, or a per-card choice), an alert on the due date, and an overdue alert. These are added to the same schedule the service worker uses for background reminders. Turn reminders off per card in its edit screen.
- **Storage:** card settings live on the card's record in the IndexedDB `debts` store (`last4`, `creditLimit`, `dueDay`, `dueSince`, `lastPaid`, `reminders`, `remindDays`, `color`). The due-date logic is `RecurringScanner.cardDueStatus(card, today)`.

## Look & feel

- **Theme (v1.16.0 redesign):** a dark-first fintech look (midnight canvas) and a clean "neo-light" mode, built from CSS variables (`--canvas`, `--card-bg`, `--card-sheen`, `--glass`, `--sheet`, `--income`/`--expense`/`--savings`…) at the top of `index.html`. A fixed colour mesh (emerald, neon blue, violet) with faint film grain sits behind everything.
- **Glass cards:** every card is frosted glass (translucent tint, top sheen, hairline highlight, 14px backdrop blur over the mesh) with 24px corners and soft layered shadows. Older browsers without backdrop blur get solid cards.
- **Colour meaning:** emerald for income and assets, rose for expenses and debt, neon blue for savings, violet for subscriptions. Summary cards carry their colour as a gradient icon chip, a glowing gradient border and a soft corner bloom (`.glow-edge` with `--accent`).
- **Hero and net worth:** the combined net balance sits on a midnight card with an emerald/neon-blue aurora, faint rings and a slowly orbiting glow border, with the cents set smaller. A full-width Net Worth card follows, with an assets-vs-debt bar.
- **Type:** Manrope, self-hosted in `fonts/` and precached by the service worker, so it works offline and no font request leaves the device. Big numbers use tight tracking and tabular figures.
- **Motion:**
  - Each tab's sections fade and slide up one after another; transaction rows (from IndexedDB or a statement preview) fade up one by one; a shimmer skeleton shows while the database opens.
  - Every button, tab and tappable card scales down when pressed (to 95%; full-width rows and large cards to 97–98% so they don't jump). Segmented controls and the nav dock have a springy sliding highlight with a glowing indicator.
  - Bottom sheets spring up over a blurred, dimmed backdrop, slide back down when closed, and can be dragged down by their handle to dismiss. Sheets render into `<body>` so a glass card can never trap them. Statement previews, batch lists, results and errors on Upload slide up into place.
  - Balances, income, expenses and savings count up to new values.
  - Charts: bars and line areas use vertical gradients (full colour fading toward the axis), bars grow one after another, lines draw in from left to right with a soft glow and smooth easing, the doughnut rotates into place, and tooltips are rounded dark glass. Legends and PDF images keep solid colours.
- **Reduce Motion:** if the phone's Reduce Motion setting is on, all of the above is switched off, including the hero's orbiting border, liquid ripples and bubbles (numbers and charts appear instantly). PDF chart images are always rendered without animation.
