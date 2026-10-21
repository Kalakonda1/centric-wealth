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
| `google-workspace.js` | Optional Google sign-in, Gmail bill scanning and Drive monthly reports |
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

## Google Workspace (optional): Gmail bills and Drive reports
**Sign-in:** uses Google Identity Services, Google's browser-only token flow. The `gapi` client library makes the API calls. No client secret and no server are involved.

### One-time setup (about 5 minutes)
1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create a project.
2. Enable the **Gmail API** and the **Google Drive API**.
3. On the OAuth consent screen, choose **External**, keep it in **Testing**, and add your Gmail address as a **test user**.
4. Create an **OAuth client ID** of type **Web application**. Add your site (e.g. `https://yourname.github.io`) to **Authorized JavaScript origins**.
5. Paste the Client ID into **Settings → Google account**, then tap **Connect Google Account**.

### Permissions
| Scope | Why |
|---|---|
| `gmail.readonly` | Read bill and statement emails. Nothing is sent, changed or deleted. |
| `drive.file` | Create reports. The app can only see files it created itself. |

`gmail.readonly` is a Google *restricted* scope. Personal use in Testing mode works. Making the app public for other people would need Google's verification and security review.

### Features
- **Upload → Sync from Gmail:** searches the last 30/60/90 days with a subject query like `statement OR bill OR invoice`. It reads the amount due, due date and sender on this device. You can **Add as bill**, **Import** a PDF or CSV attachment through the normal statement importer, or **Ignore** each email.
- **Advisor → Monthly report:** builds a Markdown or CSV report. It covers income, bank balances, credit card debt, subscriptions, and spending by category split into card and bank.
  - **Download** saves the report locally.
  - **Save Monthly Report to Drive** uploads `Financial_Report_<Month>_<Year>.md` (or `.csv`) into a "Centric Wealth Reports" folder. Saving the same month again updates that file.
  - Saved reports are listed in the app and open in a viewer.

### Sessions and errors
- **Token storage:** the access token is kept in `sessionStorage`. It's scoped to the tab and lasts about 1 hour.
- **Expired session:** shows a **Re-authenticate** button, then the action retries automatically.
- **Rate limits and server errors:** retried automatically up to 3 times.
- **Permission problems:** missing permissions or a disabled API show a message that says what to fix.
- **Offline caching:** the service worker never caches Google requests.
