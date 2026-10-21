# Centric Wealth — private, offline-first finance PWA

Everything runs in the browser. Data lives in IndexedDB on the device; there are no servers, accounts, analytics or API keys.

## Files
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
| `icon*.png`, `icon.svg` | App icons |

## Deploy to GitHub Pages
1. Create a repo and push these files to the root of `main`.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main` / `(root)`.
3. Open `https://<user>.github.io/<repo>/`. Load it once online; after that it works offline.

All paths are relative, so it works from a repo sub-path.

## Updating
Bump `VERSION` in `sw.js` on every deploy so returning visitors get the new files.

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
On the **Dashboard**, switch **Overview / Analytics** and pick 3, 6 or 12 months.

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
- **Animations:** a liquid-fill gauge, count-up numbers, bars that fill, and a floating "+$X" with a glow on deposits. All animation is turned off when the phone's Reduce Motion setting is on.
- **Storage:** funds are accounts with `kind: 'fund'`, and deposits and withdrawals are `transfer` transactions with `accountType: 'fund'`. They count in net worth and in the Advisor's emergency-fund score.
- **Reports:** funds appear in the balances, a Savings & Emergency Fund section, and the Markdown and text reports.
- **PDF chart summary:** the PDF also gets a **Chart Summary** page, with the charts drawn on the device as images.

