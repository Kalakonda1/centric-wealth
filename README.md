# Centric Wealth — private, offline-first finance PWA

Everything runs in the browser. Data lives in IndexedDB on the device; there are no servers, accounts, analytics or API keys.

## Files
| File | Purpose |
|---|---|
| `index.html` | The whole app: FinanceDB (IndexedDB wrapper) + React UI |
| `sw.js` | Service worker — caches the app and pinned CDN libraries for offline use |
| `manifest.webmanifest` | Makes it installable ("Add to Home Screen") |
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
