/*!
 * Centric Wealth - RecurringScanner
 * Finds subscriptions and fixed bills in locally saved transactions using deterministic rules
 * (no AI, no network), records Keep / Cancelled decisions, and schedules local reminders.
 *
 *   <script src="./recurring-scanner.js"></script>
 *
 *   const { items, summary } = RecurringScanner.analyze(transactions, { bills, decisions });
 *   await RecurringScanner.keep(item);          // tracks it as a bill (monthly/yearly) + remembers the choice
 *   await RecurringScanner.cancel(item);        // remembers it; later charges get flagged
 *   await RecurringScanner.notifications.requestPermission();   // call from a tap/click
 *   await RecurringScanner.notifications.sync({ items, bills, leadDays: 3 });
 *
 * Storage: the app's IndexedDB ("centric-wealth"). Decisions, the reminder schedule and the
 * notification log live in the existing `settings` store, so no schema migration is needed.
 *
 * How reminders are delivered (the web has no "fire at time X" local-notification API):
 *   1. Whenever the app is open or brought to the foreground (all platforms).
 *   2. Timers for anything due while the app stays open.
 *   3. Periodic Background Sync: Chrome on Android, installed app only; sw.js wakes roughly
 *      daily, reads the saved schedule from IndexedDB and shows due reminders.
 *   4. Notification Triggers (showTrigger), used automatically if a browser ever supports it.
 *   iPhone/iPad: notifications only work after "Add to Home Screen" (iOS 16.4+).
 */
(function (global) {
  'use strict';

  const DB_NAME = 'centric-wealth';
  const KEYS = { decisions: 'recurringDecisions', schedule: 'reminderSchedule', log: 'notificationLog', notify: 'notify' };
  const SYNC_TAG = 'centric-reminders';
  const DAY = 86400000;

  /* ------------------------------------------------------------- dates */
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseISO = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const todayISO = () => toISO(new Date());
  const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / DAY);
  const daysInMonth = (y, m0) => new Date(y, m0 + 1, 0).getDate();
  const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
  /** Add months keeping a day-of-month anchor (31st -> 30th/28th as needed). */
  const addMonths = (iso, n, anchorDay) => {
    const d = parseISO(iso); const y = d.getFullYear(), m0 = d.getMonth() + n;
    const day = anchorDay || d.getDate();
    const t = new Date(y, m0, 1);
    return toISO(new Date(t.getFullYear(), t.getMonth(), Math.min(day, daysInMonth(t.getFullYear(), t.getMonth()))));
  };
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  const mode = (a) => { const c = new Map(); let best = a[a.length - 1], n = 0; for (const v of a) { const k = (c.get(v) || 0) + 1; c.set(v, k); if (k >= n) { n = k; best = v; } } return best; };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kwRegex = (list) => new RegExp('(?:^|[^a-z0-9])(?:' + list.map((k) => escapeRe(k.toLowerCase())).join('|') + ')(?=$|[^a-z0-9])', 'i');

  /* ---------------------------------------------------- normalisation */
  const BOILERPLATE = [
    /^(?:pos|point of sale)\s+(?:purchase|debit|transaction)\s*/i,
    /^(?:debit|check|visa|mastercard|mc)\s*card\s+purchase\s*-?\s*/i,
    /^purchase\s+authori[sz]ed\s+on\s+\d{1,2}\/\d{1,2}\s*/i,
    /^(?:recurring|preauthori[sz]ed|pre-authori[sz]ed)\s+(?:debit|payment|purchase)\s*/i,
    /^(?:ach|electronic)\s+(?:debit|payment|withdrawal|pmt)\s*[-:]?\s*/i,
    /^checkcard\s+\d{4}\s*/i,
  ];
  const PROCESSOR_PREFIX = /^(?:sq|tst|sp|pp|paypal|pypl|dd|ck|in|py|fs|wpy|google|goog)\s?\*\s*/i;
  const ALIASES = [
    [/\bAMZN\s*PRIME\b|\bAMAZON\s*PRIME\b|\bPRIME\s*VIDEO\b/, 'AMAZON PRIME'],
    [/\bAPPLE\.?COM\/?BILL\b|\bITUNES\b|\bAPPLE\s+SERVICES\b/, 'APPLE SERVICES'],
    [/\bYOUTUBE\b|\bGOOGLE\s*\*?\s*YT\b/, 'YOUTUBE'],
    [/\bNETFLIX\b/, 'NETFLIX'],
    [/\bSPOTIFY\b/, 'SPOTIFY'],
    [/\bHULU\b/, 'HULU'],
    [/\bDISNEY\s*(?:PLUS|\+)\b|\bDISNEYPLUS\b/, 'DISNEY PLUS'],
    [/\bVZ\s*WIRELESS\b|\bVZWRLSS\b|\bVERIZON\b/, 'VERIZON'],
    [/\bT-?MOBILE\b/, 'T-MOBILE'],
    [/\bCOMCAST\b|\bXFINITY\b/, 'XFINITY'],
    [/\bAMZN\b|\bAMAZON\b/, 'AMAZON'],
  ];
  const STOP = new Set('THE INC LLC LTD CO CORP COM WWW NET ORG HTTPS HTTP US USA STORE PAYMENT PMT BILL ONLINE PURCHASE DEBIT CREDIT POS ACH AND AUTOPAY RECURRING MONTHLY HELP AL AK AZ AR CA CT DE FL GA HI ID IL IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));

  /** "NETFLIX.COM 866-579-7172 CA" -> "NETFLIX"; "SQ *BLUE BOTTLE #12" -> "BLUE BOTTLE". */
  function merchantKey(description) {
    let s = String(description || '').toUpperCase().replace(/\s+/g, ' ').trim();
    for (const re of BOILERPLATE) s = s.replace(re, '');
    s = s.replace(PROCESSOR_PREFIX, '');
    for (const [re, alias] of ALIASES) if (re.test(s)) return alias;
    s = s.replace(/\.(COM|NET|ORG|CO|IO|TV)\b/g, ' ').replace(/[^A-Z& ]+/g, ' ');
    const tokens = s.split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
    return tokens.slice(0, 2).join(' ') || 'UNKNOWN';
  }
  const prettyName = (key) => key.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bTv\b/, 'TV');

  /* ------------------------------------------------------ rule tables */
  // Known subscription services (matched on the raw description and the merchant key).
  const SUBSCRIPTION_RE = kwRegex(['netflix', 'spotify', 'hulu', 'disney plus', 'disneyplus', 'hbo max', 'max.com', 'paramount', 'peacock', 'youtube', 'apple services', 'icloud', 'apple music', 'apple tv', 'amazon prime', 'prime video', 'audible', 'kindle unlimited', 'siriusxm', 'pandora', 'tidal', 'dropbox', 'google one', 'google storage', 'microsoft 365', 'office 365', 'xbox game pass', 'playstation plus', 'nintendo', 'adobe', 'canva', 'notion', 'chatgpt', 'openai', 'patreon', 'substack', 'nytimes', 'new york times', 'wsj', 'washington post', 'duolingo', 'headspace', 'calm', 'peloton', 'planet fitness', 'la fitness', 'crunch fitness', 'anytime fitness', 'gym', 'twitch', 'crunchyroll', 'masterclass', 'linkedin premium', 'nordvpn', 'expressvpn', 'surfshark', '1password', 'lastpass', 'uber one', 'dashpass', 'instacart+', 'walmart+', 'costco membership', 'subscription', 'membership', 'monthly plan', 'premium']);
  // Fixed / regular bills.
  const BILL_RE = kwRegex(['rent', 'mortgage', 'hoa', 'property mgmt', 'apartments', 'electric', 'energy', 'power', 'water', 'sewer', 'gas co', 'natural gas', 'utility', 'utilities', 'trash', 'waste', 'xfinity', 'spectrum', 'cox', 'verizon', 't-mobile', 'at&t', 'att', 'mint mobile', 'cricket', 'google fi', 'internet', 'insurance', 'geico', 'progressive', 'state farm', 'allstate', 'usaa', 'loan', 'navient', 'nelnet', 'sallie mae', 'mohela', 'auto pay', 'car payment', 'tuition', 'daycare', 'childcare']);
  const BILL_CATEGORIES = new Set(['Utilities', 'Housing', 'Insurance', 'Debt Payment', 'Education']);
  // Everyday spending: only counts as recurring with an exact repeating amount, monthly or slower.
  const DISCRETIONARY = new Set(['Groceries', 'Dining', 'Dining Out', 'Transport', 'Shopping', 'Travel', 'Entertainment', 'Gifts', 'Cash', 'Other', 'Uncategorized', 'Health']);

  const CADENCES = [
    { name: 'weekly', min: 6, max: 8, days: 7, months: 0 },
    { name: 'biweekly', min: 13, max: 16, days: 14, months: 0 },
    { name: 'monthly', min: 26, max: 35, days: 30.44, months: 1 },
    { name: 'bimonthly', min: 56, max: 66, days: 61, months: 2 },
    { name: 'quarterly', min: 84, max: 98, days: 91, months: 3 },
    { name: 'semiannual', min: 170, max: 195, days: 182, months: 6 },
    { name: 'yearly', min: 350, max: 380, days: 365, months: 12 },
  ];
  const perMonth = (c) => 30.44 / c.days;
  const nextOccurrence = (iso, cadence, anchorDay) => (cadence.months ? addMonths(iso, cadence.months, anchorDay) : addDays(iso, cadence.days));

  /* ------------------------------------------------------- bill math */
  /** Same rules as the app's bill tracker: which cycle is current, and is it paid. */
  function billStatus(bill, today) {
    today = today || todayISO();
    const t = parseISO(today);
    const yearly = bill.frequency === 'yearly';
    const occ = (y, m0) => new Date(y, m0, Math.min(bill.dueDay || 1, daysInMonth(y, m0)));
    const step = (d, n) => (yearly ? occ(d.getFullYear() + n, d.getMonth()) : occ(d.getFullYear(), d.getMonth() + n));
    let next = yearly ? occ(t.getFullYear(), (bill.dueMonth || 1) - 1) : occ(t.getFullYear(), t.getMonth());
    if (next < t) next = step(next, 1);
    const prev = step(next, -1), prev2 = step(next, -2);
    const ref = bill.lastPaid ? parseISO(bill.lastPaid) : bill.createdAt ? parseISO(bill.createdAt.slice(0, 10)) : t;
    const out = (cur, paid) => ({ currentDue: toISO(cur), nextDue: toISO(paid ? step(cur, 1) : cur), followingDue: toISO(step(paid ? step(cur, 1) : cur, 1)), paid, daysLeft: daysBetween(today, toISO(cur)) });
    if (ref > prev) return bill.lastPaid ? out(next, true) : out(next, false);
    if (ref > prev2) return out(next, false);
    return out(prev, false);
  }

  /* ========================================================= analysis */
  /**
   * Pure, synchronous detection.
   * @param {Array} transactions  app records ({date, description, amount, type, category, id}) or
   *                              signed records ({date, description, amount<0 for money out})
   * @param {object} opts { bills, decisions, today }
   * @returns {{ items: RecurringItem[], summary: object }}
   */
  function analyze(transactions, opts) {
    opts = opts || {};
    const today = opts.today || todayISO();
    const decisions = opts.decisions || {};
    const bills = opts.bills || [];

    // 1. Outgoing money only; skip transfers and income.
    const out = [];
    let dataEnd = null;
    for (const t of transactions || []) {
      if (!t || !t.date || !isFinite(t.amount) || !t.amount) continue;
      if (!dataEnd || t.date > dataEnd) dataEnd = t.date;
      const isOut = t.type ? t.type === 'expense' : t.amount < 0;
      if (!isOut) continue;
      out.push({ id: t.id, date: String(t.date).slice(0, 10), description: String(t.description || ''), amount: Math.abs(Number(t.amount)), category: t.statementCategory && t.statementCategory !== 'Uncategorized' ? t.statementCategory : t.category || '' });
    }
    // Measure "missing" charges against the newest imported data, not the calendar,
    // so a statement imported weeks later doesn't make everything look cancelled.
    const horizon = dataEnd && dataEnd < today ? dataEnd : today;

    // 2. Group by normalised merchant.
    const groups = new Map();
    for (const t of out) {
      const key = merchantKey(t.description);
      if (key === 'UNKNOWN') continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }

    const items = [];
    for (const [key, txs] of groups) {
      txs.sort((a, b) => a.date.localeCompare(b.date));
      const sample = txs[txs.length - 1];
      const raw = txs.map((t) => t.description).join(' | ');
      const isSub = SUBSCRIPTION_RE.test(raw) || SUBSCRIPTION_RE.test(key) || txs.some((t) => t.category === 'Subscriptions');
      const isBill = !isSub && (BILL_RE.test(raw) || BILL_RE.test(key) || txs.some((t) => BILL_CATEGORIES.has(t.category)));
      const discretionary = !isSub && !isBill && DISCRETIONARY.has(sample.category);
      // Amount tolerance: utilities vary month to month; subscriptions change price occasionally.
      const tol = isBill ? 0.4 : isSub ? 0.25 : 0.03;

      // 3. Cluster by amount (two Apple charges of 2.99 and 10.99 are two subscriptions).
      const clusters = [];
      for (const t of [...txs].sort((a, b) => a.amount - b.amount)) {
        const c = clusters.find((cl) => Math.abs(t.amount - median(cl.map((x) => x.amount))) <= Math.max(isBill || isSub ? 1 : 0.5, tol * t.amount));
        c ? c.push(t) : clusters.push([t]);
      }

      const decision = decisions[key];
      for (const cluster of clusters) {
        cluster.sort((a, b) => a.date.localeCompare(b.date));
        const amounts = cluster.map((t) => t.amount);
        const maxAmt = Math.max(...amounts);
        if (maxAmt <= 1 && clusters.some((c) => c !== cluster && c[0].amount > 1)) continue; // $0-$1 trial/verification hold
        const dates = [...new Set(cluster.map((t) => t.date))];
        const intervals = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
        const spread = (maxAmt - Math.min(...amounts)) / maxAmt;

        // 4. Cadence + confidence.
        let cadence = null, confidence = null;
        if (intervals.length) {
          const med = median(intervals);
          const band = CADENCES.find((c) => med >= c.min && med <= c.max);
          if (band) {
            const inBand = intervals.filter((iv) => iv >= band.min - 2 && iv <= band.max + 2).length / intervals.length;
            if (dates.length >= 3 && inBand >= 0.75 && (spread <= 0.02 || isBill)) { cadence = band; confidence = 'high'; }
            else if (dates.length >= 3 && inBand >= 0.6) { cadence = band; confidence = 'medium'; }
            else if (dates.length === 2 && band.months >= 1 && (spread <= 0.05 || isSub || isBill)) { cadence = band; confidence = 'medium'; }
            else if (dates.length >= 3 && isSub) { cadence = band; confidence = 'low'; }
          }
        }
        // Single sighting of a known subscription in the newest ~45 days of data.
        if (!cadence && isSub && dates.length <= 2 && daysBetween(dates[dates.length - 1], horizon) <= 45) { cadence = CADENCES[2]; confidence = 'low'; }
        if (!cadence) continue;
        if (discretionary) {
          // Everyday merchants (cafe, fuel, groceries) need strong evidence: 4+ identical charges,
          // monthly or slower, on a consistent day of the month. Weekly coffee is a habit, not a bill.
          const days = dates.map((d) => parseISO(d).getDate());
          const dayDrift = Math.max(...days) - Math.min(...days);
          if (cadence.months < 1 || spread > 0.01 || dates.length < 4 || dayDrift > 3) continue;
        }

        // 5. Timing.
        const last = cluster[cluster.length - 1];
        const anchorDay = cadence.months ? mode(cluster.slice(-4).map((t) => parseISO(t.date).getDate())) : null;
        const expected = nextOccurrence(last.date, cadence, anchorDay);
        const missing = daysBetween(expected, horizon) > Math.max(5, Math.round(cadence.days * 0.2));
        let nextDue = expected;
        while (nextDue < today) nextDue = nextOccurrence(nextDue, cadence, anchorDay);
        const avg = round2(amounts.reduce((s, a) => s + a, 0) / amounts.length);
        const active = !missing && !(decision && decision.status === 'cancelled');

        // 6. Deterministic review flags.
        const flags = [];
        const prevDiff = [...cluster].reverse().find((t) => Math.abs(t.amount - last.amount) > 0.009);
        if (prevDiff && prevDiff.amount < last.amount && !isBill) flags.push({ code: 'price_increase', severity: 'warn', message: 'Price went up from ' + prevDiff.amount.toFixed(2) + ' to ' + last.amount.toFixed(2) });
        const short = intervals.find((iv) => iv < cadence.min * 0.5);
        if (short != null) flags.push({ code: 'duplicate_charge', severity: 'warn', message: 'Charged twice within ' + short + ' day' + (short === 1 ? '' : 's') });
        const firstOfMerchant = txs[0];
        if (firstOfMerchant.amount <= 1 && last.amount > 1) flags.push({ code: 'trial_conversion', severity: 'info', message: 'Started as a ' + firstOfMerchant.amount.toFixed(2) + ' trial' });
        if (decision && decision.status === 'cancelled') {
          const after = txs.filter((t) => t.date > decision.at && Math.abs(t.amount - (decision.amount || t.amount)) <= Math.max(1, 0.3 * t.amount));
          if (after.length) flags.push({ code: 'charged_after_cancel', severity: 'danger', message: 'Charged ' + after[after.length - 1].amount.toFixed(2) + ' on ' + after[after.length - 1].date + ' after you cancelled', date: after[after.length - 1].date });
        }
        if (missing && !(decision && decision.status === 'cancelled')) flags.push({ code: 'missing', severity: 'info', message: 'No charge since ' + last.date + ' - it may already be cancelled' });

        const id = clusters.length > 1 ? key + '|' + Math.round(avg) : key;
        items.push({
          key: id,
          merchantKey: key,
          merchant: prettyName(key),
          description: last.description,
          kind: isSub ? 'subscription' : isBill ? 'bill' : 'recurring',
          category: last.category || (isSub ? 'Subscriptions' : ''),
          cadence: cadence.name,
          cadenceDays: cadence.days,
          confidence,
          occurrences: cluster.length,
          averageAmount: avg,
          lastAmount: round2(last.amount),
          firstDate: cluster[0].date,
          lastDate: last.date,
          dueDay: anchorDay,
          nextDue,
          daysUntilDue: daysBetween(today, nextDue),
          active,
          monthlyCost: round2(avg * perMonth(cadence)),
          annualCost: round2(avg * perMonth(cadence) * 12),
          flags,
          status: 'new',
          billId: null,
          transactionIds: cluster.map((t) => t.id).filter(Boolean),
        });
      }
    }

    // 7. Merge decisions and existing bills.
    for (const it of items) {
      const d = decisions[it.key] || decisions[it.merchantKey];
      const bill = findBill(it, bills, d);
      if (bill) it.billId = bill.id;
      if (d) { it.status = d.status; it.decidedAt = d.at; }
      else if (bill && bill.active !== false) it.status = 'kept'; // already tracked by hand
    }
    // Drop stale, low-signal leftovers nobody needs to review.
    const visible = items.filter((it) => !(it.status === 'new' && !it.active && it.confidence === 'low'));

    const rank = (it) => (it.flags.some((f) => f.severity === 'danger') ? 0 : it.status === 'new' ? 1 : it.status === 'kept' ? 2 : 3);
    const kindRank = { subscription: 0, bill: 1, recurring: 2 };
    const flagged = (it) => (it.flags.some((f) => f.severity === 'warn') ? 0 : 1);
    visible.sort((a, b) => rank(a) - rank(b) || flagged(a) - flagged(b) || kindRank[a.kind] - kindRank[b.kind] || b.monthlyCost - a.monthlyCost);

    const live = visible.filter((it) => it.active && it.status !== 'cancelled');
    const summary = {
      monthlyTotal: round2(live.reduce((s, it) => s + it.monthlyCost, 0)),
      annualTotal: round2(live.reduce((s, it) => s + it.annualCost, 0)),
      subscriptions: live.filter((it) => it.kind === 'subscription').length,
      bills: live.filter((it) => it.kind !== 'subscription').length,
      needsReview: visible.filter((it) => it.status === 'new' || it.flags.some((f) => f.severity === 'danger')).length,
      cancelledSavingsAnnual: round2(visible.filter((it) => it.status === 'cancelled').reduce((s, it) => s + it.annualCost, 0)),
      dataThrough: dataEnd,
    };
    return { items: visible, summary };
  }

  function findBill(item, bills, decision) {
    if (decision && decision.billId) { const b = bills.find((x) => x.id === decision.billId); if (b) return b; }
    const byKey = bills.find((b) => b.recurringKey === item.key);
    if (byKey) return byKey;
    // Hand-made bills: share a meaningful word with the merchant ("Rent" ~ "RENT OAK APARTMENTS") and a similar amount.
    const itemTokens = new Set(item.merchantKey.split(' ').filter((t) => t.length >= 3));
    const amountOk = (b) => Math.abs(Number(b.amount) - item.lastAmount) <= Math.max(1, 0.35 * item.lastAmount);
    return bills.find((b) => merchantKey(b.name) === item.merchantKey && amountOk(b)) ||
      bills.find((b) => amountOk(b) && String(b.name || '').toUpperCase().split(/[^A-Z0-9]+/).some((t) => t.length >= 3 && itemTokens.has(t))) || null;
  }

  /* =========================================================== storage */
  function rawOpen() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error('IndexedDB is not available'));
      const req = indexedDB.open(DB_NAME);
      req.onupgradeneeded = () => { req.transaction.abort(); }; // never create the DB here; the app owns its schema
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('Open the app once before using RecurringScanner (' + (req.error && req.error.message) + ')'));
    });
  }
  const store = {
    async getAll(name) {
      if (global.FinanceDB) return global.FinanceDB.getAll(name);
      const db = await rawOpen();
      try { return await new Promise((res, rej) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); } finally { db.close(); }
    },
    async getSetting(key, fallback) {
      if (global.FinanceDB) return global.FinanceDB.getSetting(key, fallback);
      const db = await rawOpen();
      try { return await new Promise((res, rej) => { const r = db.transaction('settings').objectStore('settings').get(key); r.onsuccess = () => res(r.result ? r.result.value : fallback); r.onerror = () => rej(r.error); }); } finally { db.close(); }
    },
    async setSetting(key, value) {
      if (global.FinanceDB) return global.FinanceDB.setSetting(key, value);
      const db = await rawOpen();
      try { await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put({ key, value }); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } finally { db.close(); }
    },
    async put(name, rec) {
      if (global.FinanceDB) return global.FinanceDB.put(name, rec);
      const now = new Date().toISOString();
      const full = Object.assign({ id: rec.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)), createdAt: now }, rec, { updatedAt: now });
      const db = await rawOpen();
      try { await new Promise((res, rej) => { const tx = db.transaction(name, 'readwrite'); tx.objectStore(name).put(full); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } finally { db.close(); }
      return full;
    },
  };

  /** Load everything from IndexedDB and analyse it. */
  async function scan(opts) {
    opts = opts || {};
    const [transactions, bills, decisions] = await Promise.all([
      opts.transactions || store.getAll('transactions'),
      opts.bills || store.getAll('bills'),
      opts.decisions || store.getSetting(KEYS.decisions, {}),
    ]);
    return Object.assign(analyze(transactions, { bills, decisions, today: opts.today }), { bills, decisions });
  }

  /* ========================================================= decisions */
  const BILL_CATEGORY = { subscription: 'Subscriptions', bill: 'Utilities', recurring: 'Other' };
  const APP_EXPENSE_CATEGORIES = ['Housing', 'Utilities', 'Groceries', 'Dining', 'Transport', 'Health', 'Insurance', 'Shopping', 'Entertainment', 'Subscriptions', 'Debt Payment', 'Education', 'Travel', 'Gifts', 'Other'];

  async function setDecision(key, value) {
    const all = Object.assign({}, await store.getSetting(KEYS.decisions, {}));
    if (value == null) delete all[key]; else all[key] = value;
    await store.setSetting(KEYS.decisions, all);
    return all;
  }

  /** Keep: remember the choice and (for monthly/yearly cadences) track it as a bill with due dates. */
  async function keep(item) {
    let billId = item.billId || null;
    const bills = await store.getAll('bills');
    const existing = billId ? bills.find((b) => b.id === billId) : null;
    if (existing) {
      await store.put('bills', Object.assign({}, existing, { active: true }));
    } else if (item.cadence === 'monthly' || item.cadence === 'yearly') {
      const due = parseISO(item.lastDate);
      const category = APP_EXPENSE_CATEGORIES.includes(item.category) ? item.category : BILL_CATEGORY[item.kind];
      const rec = await store.put('bills', {
        name: item.merchant, amount: item.lastAmount, frequency: item.cadence,
        dueDay: item.dueDay || due.getDate(), dueMonth: due.getMonth() + 1,
        category, isSubscription: item.kind === 'subscription', active: true,
        lastPaid: item.lastDate,           // the latest charge already happened
        logExpense: false,                 // charges arrive through imports; don't double count
        recurringKey: item.key, createdBy: 'recurring-scanner',
      });
      billId = rec.id;
    }
    await setDecision(item.key, { status: 'kept', at: todayISO(), amount: item.lastAmount, cadence: item.cadence, billId });
    return billId;
  }

  /** Mark as Cancelled: stop tracking/reminding; any later charge is flagged "charged after cancel". */
  async function cancel(item) {
    if (item.billId) {
      const b = (await store.getAll('bills')).find((x) => x.id === item.billId);
      if (b) await store.put('bills', Object.assign({}, b, { active: false }));
    }
    await setDecision(item.key, { status: 'cancelled', at: todayISO(), amount: item.lastAmount, cadence: item.cadence, billId: item.billId || null, annualCost: item.annualCost });
  }

  /** Undo a Keep/Cancel choice. Re-activates a linked bill that Cancel had paused. */
  async function undo(item) {
    const d = (await store.getSetting(KEYS.decisions, {}))[item.key];
    if (d && d.status === 'cancelled' && d.billId) {
      const b = (await store.getAll('bills')).find((x) => x.id === d.billId);
      if (b) await store.put('bills', Object.assign({}, b, { active: true }));
    }
    await setDecision(item.key, null);
  }

  /**
   * Keep bills created by Keep in step with newly imported charges (advances lastPaid, follows price changes).
   * Returns the number of bills updated.
   */
  async function reconcile(items, bills) {
    let n = 0;
    for (const it of items) {
      if (it.status !== 'kept' || !it.billId || it.lastDate > todayISO()) continue;
      const b = bills.find((x) => x.id === it.billId);
      if (!b) continue;
      const patch = {};
      // A detected charge pays the bill's cycle (works for hand-made bills too).
      if (!b.lastPaid || it.lastDate > b.lastPaid) patch.lastPaid = it.lastDate;
      // Follow price changes only on bills this module created; leave the user's own amounts alone.
      if (b.createdBy === 'recurring-scanner' && Math.abs(b.amount - it.lastAmount) > 0.009 && it.kind === 'subscription') patch.amount = it.lastAmount;
      if (Object.keys(patch).length) { await store.put('bills', Object.assign({}, b, patch)); n++; }
    }
    return n;
  }

  /* ===================================================== notifications */
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => (global.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const hasTriggers = () => typeof global.TimestampTrigger === 'function' && global.Notification && 'showTrigger' in Notification.prototype;
  let timers = [];

  async function swRegistration() {
    if (!('serviceWorker' in navigator)) return null;
    try { return (await navigator.serviceWorker.getRegistration()) || null; } catch (_) { return null; }
  }

  async function registerBackground() {
    try {
      const reg = await swRegistration();
      if (!reg || !('periodicSync' in reg)) return 'none';
      const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (perm.state !== 'granted') return 'none'; // Chrome grants this only to installed apps
      await reg.periodicSync.register(SYNC_TAG, { minInterval: 12 * 60 * 60 * 1000 });
      return 'periodic-sync';
    } catch (_) { return 'none'; }
  }

  const notifications = {
    /** Capabilities and current state, for the settings screen. */
    async status() {
      const supported = 'Notification' in global;
      const permission = supported ? Notification.permission : 'unsupported';
      let background = 'none';
      try {
        const reg = await swRegistration();
        if (reg && 'periodicSync' in reg) background = (await reg.periodicSync.getTags()).includes(SYNC_TAG) ? 'periodic-sync' : 'available-when-installed';
      } catch (_) {}
      if (hasTriggers()) background = 'triggers';
      let note = '';
      if (!supported && isIOS() && !isStandalone()) note = 'On iPhone, add Centric Wealth to your Home Screen (Share > Add to Home Screen), then turn reminders on from the installed app.';
      else if (!supported) note = 'This browser does not support notifications.';
      else if (permission === 'denied') note = 'Notifications are blocked. Allow them in your browser or phone settings for this site.';
      else if (background === 'periodic-sync' || background === 'triggers') note = 'Reminders can arrive in the background.';
      else if (background === 'available-when-installed') note = 'Install the app to get reminders in the background. Until then they appear when you open it.';
      else note = 'Reminders appear when you open the app.';
      return { supported, permission, installed: isStandalone(), background, ios: isIOS(), note };
    },

    /** Ask for permission. Must be called directly from a tap/click handler (required on mobile). */
    async requestPermission() {
      if (!('Notification' in global)) return { granted: false, reason: isIOS() && !isStandalone() ? 'ios-install-required' : 'unsupported' };
      if (Notification.permission === 'denied') return { granted: false, reason: 'denied' };
      let p = Notification.permission;
      if (p !== 'granted') {
        // Older Safari uses the callback form.
        p = await new Promise((resolve) => { const r = Notification.requestPermission(resolve); if (r && r.then) r.then(resolve); });
      }
      if (p !== 'granted') return { granted: false, reason: p === 'denied' ? 'denied' : 'dismissed' };
      const background = await registerBackground();
      return { granted: true, background };
    },

    /**
     * Build the reminder list from bills (due-date fields) and detected recurring charges.
     * Includes the next two cycles so background delivery still works if the app isn't opened for a while.
     */
    buildSchedule({ items = [], bills = [], leadDays = 3, today } = {}) {
      today = today || todayISO();
      const out = [];
      const at9 = (iso) => { const d = parseISO(iso); d.setHours(9, 0, 0, 0); return d.toISOString(); };
      const fmtDay = (iso) => parseISO(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const money = (n) => Number(n).toFixed(2);
      const whenText = (due) => { const d = daysBetween(today, due); return d < 0 ? 'was due ' + fmtDay(due) : d === 0 ? 'is due today' : d === 1 ? 'is due tomorrow (' + fmtDay(due) + ')' : 'is due ' + fmtDay(due); };
      const add = (id, name, amount, due, kind) => out.push({
        tag: 'due-' + id + '-' + due, kind, dueDate: due, notifyAt: at9(addDays(due, -leadDays)),
        title: kind === 'subscription' ? 'Subscription renewing' : 'Bill reminder',
        body: name + ' ' + money(amount) + ' ' + whenText(due), url: './#budget/bills',
      });

      const tracked = new Set();
      for (const b of bills) {
        if (b.active === false) continue;
        if (b.recurringKey) tracked.add(b.recurringKey);
        const st = billStatus(b, today);
        if (!st.paid) add(b.id, b.name, b.amount, st.currentDue, b.isSubscription ? 'subscription' : 'bill');
        add(b.id, b.name, b.amount, st.paid ? st.nextDue : st.followingDue, b.isSubscription ? 'subscription' : 'bill');
      }
      for (const it of items) {
        if (it.status === 'cancelled' || !it.active || tracked.has(it.key) || it.billId) continue;
        if (it.status !== 'kept' && it.confidence === 'low') continue;
        const cad = CADENCES.find((c) => c.name === it.cadence);
        add(it.key.replace(/\W+/g, '_'), it.merchant, it.lastAmount, it.nextDue, it.kind);
        add(it.key.replace(/\W+/g, '_'), it.merchant, it.lastAmount, nextOccurrence(it.nextDue, cad, it.dueDay), it.kind);
      }
      for (const it of items) {
        const f = it.flags.find((x) => x.code === 'charged_after_cancel');
        if (f) out.push({ tag: 'cancelled-' + it.key.replace(/\W+/g, '_') + '-' + f.date, kind: 'alert', dueDate: f.date, notifyAt: new Date().toISOString(), title: 'Charged after cancelling', body: it.merchant + ': ' + f.message, url: './#dashboard', urgent: true });
      }
      return out.sort((a, b) => a.notifyAt.localeCompare(b.notifyAt));
    },

    /** Save the schedule (for the service worker), show anything due now, and arm timers. */
    async sync({ items = [], bills = [], leadDays = 3, enabled } = {}) {
      timers.forEach(clearTimeout); timers = [];
      if (enabled === undefined) enabled = await store.getSetting(KEYS.notify, false);
      const schedule = notifications.buildSchedule({ items, bills, leadDays });
      await store.setSetting(KEYS.schedule, { updatedAt: new Date().toISOString(), leadDays, items: schedule });
      if (!enabled || !('Notification' in global) || Notification.permission !== 'granted') return { scheduled: schedule.length, delivered: 0, mode: 'off' };

      const delivered = await deliverDue(schedule);
      const now = Date.now();
      for (const s of schedule) {
        const ms = new Date(s.notifyAt).getTime() - now;
        if (ms > 0 && ms <= DAY) timers.push(setTimeout(() => deliverDue([s]), ms));
      }
      let mode = (await registerBackground()) === 'periodic-sync' ? 'background' : 'foreground';
      if (hasTriggers()) {
        mode = 'triggers';
        const reg = await swRegistration();
        const log = await store.getSetting(KEYS.log, {});
        for (const s of schedule) {
          const ts = new Date(s.notifyAt).getTime();
          if (!reg || ts <= now || ts - now > 30 * DAY || log['trigger:' + s.tag]) continue;
          try { await reg.showNotification(s.title, { body: s.body, tag: s.tag, icon: './icon-192.png', badge: './icon-192.png', data: { url: s.url }, showTrigger: new global.TimestampTrigger(ts) }); log['trigger:' + s.tag] = new Date().toISOString(); } catch (_) {}
        }
        await store.setSetting(KEYS.log, log);
      }
      return { scheduled: schedule.length, delivered, mode };
    },

    /** Show a one-off test notification (from a tap). */
    async test() {
      return show({ title: 'Centric Wealth', body: 'Reminders are working.', tag: 'test-' + Date.now(), url: './#settings' });
    },
  };

  async function show(n) {
    const opts = { body: n.body, tag: n.tag, icon: './icon-192.png', badge: './icon-192.png', data: { url: n.url || './' }, requireInteraction: !!n.urgent };
    const reg = await swRegistration();
    try {
      if (reg) await reg.showNotification(n.title, opts);
      else new Notification(n.title, opts); // desktop without a service worker; Android requires the SW path
      return true;
    } catch (_) { return false; }
  }

  /** Show schedule entries that are due and haven't been shown yet. */
  async function deliverDue(schedule) {
    const log = Object.assign({}, await store.getSetting(KEYS.log, {}));
    const now = new Date(), nowISO = now.toISOString(), cutoff = addDays(todayISO(), -3);
    let n = 0;
    for (const s of schedule) {
      if (s.notifyAt > nowISO || s.dueDate < cutoff || log[s.tag]) continue;
      if (await show(s)) { log[s.tag] = nowISO; n++; }
    }
    // Forget entries older than 90 days.
    const old = new Date(now.getTime() - 90 * DAY).toISOString();
    for (const k of Object.keys(log)) if (log[k] < old) delete log[k];
    if (n) await store.setSetting(KEYS.log, log);
    return n;
  }

  global.RecurringScanner = {
    version: '1.0.0',
    analyze, scan, keep, cancel, undo, reconcile,
    merchantKey, billStatus,
    notifications,
    SETTINGS_KEYS: KEYS, SYNC_TAG,
  };
})(typeof window !== 'undefined' ? window : globalThis);
