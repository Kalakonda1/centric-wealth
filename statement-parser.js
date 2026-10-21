/*!
 * Centric Wealth - StatementParser
 * Client-side bank & credit-card statement parser. No servers, no AI APIs, no keys.
 *
 *   PDF  -> pdf.js (text layer)      CSV/TSV -> PapaParse
 *   -> deterministic categorisation (keyword/regex rule dictionary)
 *   -> recurring/subscription detection (grouping + cadence heuristics)
 *   -> standardised JSON -> IndexedDB (same "centric-wealth" DB the app uses)
 *
 * Usage (classic <script>, works on GitHub Pages without a bundler):
 *   <script src="./statement-parser.js"></script>
 *   const txs = await StatementParser.parseStatement(file);
 *   // -> [{ date:'2026-10-02', description:'Whole Foods', amount:-84.2, category:'Groceries', isRecurring:false }, ...]
 *
 *   const report = await StatementParser.parseStatementDetailed(file);
 *
 *   // Tell it what kind of statement it is and which account it belongs to:
 *   await StatementParser.parseStatement(file, { accountType: 'credit', accountName: 'Amex Gold' });
 *   // -> { transactions, recurring, warnings, meta, saved }
 *
 * Sign convention: amount < 0 = money out (purchase, bill, fee); amount > 0 = money in.
 *
 * Errors are thrown as StatementParser.StatementParserError with a stable `code`:
 *   EMPTY_FILE, FILE_TOO_LARGE, UNSUPPORTED_TYPE, LIB_LOAD_FAILED, PDF_PASSWORD,
 *   PDF_INVALID, PDF_NO_TEXT, CSV_INVALID, NO_TRANSACTIONS, STORAGE_UNAVAILABLE, STORAGE_FAILED
 * Row-level problems (bad dates, missing amounts...) never throw; they are skipped and
 * reported in `warnings` (detailed API) or via the `onWarning` callback.
 */
(function (global) {
  'use strict';

  /* ======================================================================
   * Config
   * ==================================================================== */
  const config = {
    // Pinned CDN builds. Self-host these files and change the URLs for 100% offline installs.
    libs: {
      pdfjs: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs',
      pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.mjs',
      papaparse: 'https://cdn.jsdelivr.net/npm/papaparse@5.5.3/papaparse.min.js',
    },
    maxFileBytes: 25 * 1024 * 1024,
    maxPdfPages: 200,
    db: { name: 'centric-wealth', store: 'transactions' },
  };

  /* ======================================================================
   * Errors
   * ==================================================================== */
  class StatementParserError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'StatementParserError';
      this.code = code;
      if (details) Object.assign(this, details);
    }
  }
  const fail = (code, msg, details) => { throw new StatementParserError(code, msg, details); };

  /* ======================================================================
   * Small utilities
   * ==================================================================== */
  const pad = (n) => String(n).padStart(2, '0');
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);
  const isValidYMD = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate() && y >= 1990 && y <= 2100;
  const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isBlank = (v) => v == null || String(v).trim() === '';

  /* ======================================================================
   * Dates
   * ==================================================================== */
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const monthNum = (t) => { const k = t.toLowerCase().replace('.', ''); return MONTHS[k.slice(0, 4)] || MONTHS[k.slice(0, 3)]; };
  const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  const DATE_SRC = `(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}(?:[-/.]\\d{2,4})?|${MON}\\s+\\d{1,2}(?:,?\\s+\\d{4})?|\\d{1,2}[-\\s]${MON}(?:[-\\s,]+\\d{2,4})?)`;
  const LINE_START_DATE = new RegExp(`^\\s*(${DATE_SRC})(?=\\s)`, 'i');

  /**
   * Parse a date token. order: 'MDY' | 'DMY'. ref: Date used to infer a missing year
   * (statement closing date). Returns 'YYYY-MM-DD' or null.
   */
  function parseDateToken(raw, { order = 'MDY', ref = null } = {}) {
    if (isBlank(raw)) return null;
    // Drop a trailing time ("10/02/2026 14:33", "2026-10-02T09:00:00Z").
    const s = String(raw).trim().replace(/\s+/g, ' ').replace(/(?:T|\s)\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:[AP]M)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/i, '');
    let y, m, d, m2;
    if ((m2 = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/))) { [y, m, d] = [+m2[1], +m2[2], +m2[3]]; }
    else if ((m2 = s.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/))) {
      let a = +m2[1], b = +m2[2];
      if (order === 'DMY') [d, m] = [a, b]; else [m, d] = [a, b];
      y = m2[3] ? +m2[3] : null;
    } else if ((m2 = s.match(new RegExp(`^(${MON})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?$`, 'i')))) {
      m = monthNum(m2[1]); d = +m2[2]; y = m2[3] ? +m2[3] : null;
    } else if ((m2 = s.match(new RegExp(`^(\\d{1,2})[-\\s](${MON})(?:[-\\s,]+(\\d{2,4}))?$`, 'i')))) {
      d = +m2[1]; m = monthNum(m2[2]); y = m2[3] ? +m2[3] : null;
    } else {
      return null;
    }
    if (y != null && y < 100) y += 2000;
    if (y == null) {
      // No year on the line (common in PDFs): use the statement's closing date.
      const r = ref || new Date();
      y = r.getFullYear();
      // A December transaction on a January statement belongs to the previous year.
      if (isValidYMD(y, m, d) && new Date(y, m - 1, d) - r > 7 * 86400000) y -= 1;
    }
    return isValidYMD(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
  }

  /** Decide MDY vs DMY from a sample of numeric date strings (a first part > 12 means DMY). */
  function detectDateOrder(samples) {
    let mdy = 0, dmy = 0;
    for (const s of samples) {
      const m = String(s || '').trim().match(/^(\d{1,2})[-/.](\d{1,2})/);
      if (!m) continue;
      if (+m[1] > 12) dmy++;
      if (+m[2] > 12) mdy++;
    }
    return dmy > mdy ? 'DMY' : 'MDY';
  }

  /* ======================================================================
   * Money
   * ==================================================================== */
  // Dot-decimal (1,234.56) or comma-decimal (1.234,56). Requires 2 decimals so account/ref numbers don't match.
  const MONEY_SRC = '(?:\\(\\s*)?[-\u2212\u2013]?[$\u20ac\u00a3\u20b9]?\\s?(?:(?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2}|(?:\\d{1,3}(?:\\.\\d{3})+|\\d+),\\d{2})(?:\\s*\\))?(?:\\s?(?:CR|DR)\\b|-(?=\\s|$))?';
  const TRAILING_MONEY = new RegExp(`(?:^|\\s)(${MONEY_SRC})\\s*$`, 'i');

  /** Parse a money string. Returns { value (>=0), explicitSign: -1|0|1, cr, dr } or null. */
  function parseMoney(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return isFinite(raw) ? { value: Math.abs(raw), explicitSign: Math.sign(raw) || 0, cr: false, dr: false } : null;
    let s = String(raw).trim();
    if (!s) return null;
    const cr = /\bCR\b/i.test(s), dr = /\bDR\b/i.test(s);
    const neg = /^\(.*\)$/.test(s.replace(/\s*(CR|DR)$/i, '')) || /^[-\u2212\u2013]/.test(s.replace(/^[$\u20ac\u00a3\u20b9\s]+/, '')) || /[$\u20ac\u00a3\u20b9]\s?[-\u2212\u2013]/.test(s) || /\d-$/.test(s);
    s = s.replace(/\b(CR|DR)\b/gi, '').replace(/[^0-9.,]/g, '');
    if (!/\d/.test(s)) return null;
    const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot && /,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
    else s = s.replace(/,/g, '');
    const value = parseFloat(s);
    if (!isFinite(value)) return null;
    return { value: round2(value), explicitSign: neg ? -1 : 0, cr, dr };
  }

  /* ======================================================================
   * Description cleaning & merchant keys
   * ==================================================================== */
  const BOILERPLATE = [
    /^(?:pos|point of sale)\s+(?:purchase|debit|transaction)\s*/i,
    /^(?:debit|check|visa|mastercard|mc)\s*card\s+purchase\s*(?:-|\u2013)?\s*/i,
    /^purchase\s+authori[sz]ed\s+on\s+\d{1,2}\/\d{1,2}\s*/i,
    /^(?:recurring|preauthori[sz]ed|pre-authori[sz]ed)\s+(?:debit|payment|purchase)\s*/i,
    /^(?:ach|electronic|online)\s+(?:debit|credit|payment|withdrawal|pmt)\s*[-:]?\s*/i,
    /^checkcard\s+\d{4}\s*/i,
    /^(?:card|debit)\s+\d{4}\s*/i,
    /^(?:purchase|debit|withdrawal)\s*[-:]\s*/i,
  ];
  const PROCESSOR_PREFIX = /^(?:sq\s?\*|tst\s?\*|sp\s?\*|pp\s?\*|paypal\s?\*|pypl\s?\*|dd\s?\*|doordash\s?\*(?=\w)|ck\s?\*|in\s?\*|py\s?\*|fs\s?\*|wpy\s?\*)\s*/i;

  /** Human-readable cleaned description. */
  function cleanDescription(raw) {
    let s = String(raw || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    for (const re of BOILERPLATE) {
      const next = s.replace(re, '');
      // Keep "ONLINE PAYMENT - THANK YOU" intact: only strip when a real merchant name remains.
      if (next !== s && (next.match(/[a-z]/gi) || []).length >= 4 && !/^[-\u2013\s]*thank/i.test(next)) s = next;
    }
    s = s.replace(PROCESSOR_PREFIX, '');
    s = s
      .replace(/\b(?:card|acct|account)\s*(?:#|no\.?|ending(?: in)?)?\s*[x*]*\d{4}\b/gi, '')
      .replace(/\b[x*]{2,}\d{2,}\b/gi, '')
      .replace(/\b(?:ref|reference|trace|conf|confirmation|id|auth)\s*(?:#|no\.?|:)?\s*[a-z0-9]{6,}\b/gi, '')
      .replace(/\b\d{9,}\b/g, '')
      .replace(/\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*$/, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-\u2013:*#]+|[\s\-\u2013:*#]+$/g, '')
      .trim();
    return s || String(raw || '').trim();
  }

  const MERCHANT_ALIASES = [
    [/\bAMZN\b|\bAMAZON(?:\.COM)?\b|\bAMZ\b/, 'AMAZON'],
    [/\bAPPLE\.COM\/BILL\b|\bAPPLE COM BILL\b|\bITUNES\b/, 'APPLE SERVICES'],
    [/\bGOOGLE\s*\*?\s*(?:YOUTUBE|YT)\b/, 'YOUTUBE'],
    [/\bWAL-?MART\b|\bWM SUPERCENTER\b/, 'WALMART'],
  ];
  const STOPWORDS = new Set(['THE', 'INC', 'LLC', 'LTD', 'CO', 'CORP', 'COM', 'WWW', 'NET', 'ORG', 'HTTPS', 'HTTP', 'US', 'USA', 'STORE', 'STORES', 'PAYMENT', 'PMT', 'BILL', 'ONLINE', 'PURCHASE', 'DEBIT', 'CREDIT', 'POS', 'ACH', 'AND',
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC']);

  /** Stable key used to group the same merchant across months ("NETFLIX.COM 866-579" -> "NETFLIX"). */
  function merchantKey(description) {
    let s = cleanDescription(description).toUpperCase().replace(PROCESSOR_PREFIX, '');
    for (const [re, alias] of MERCHANT_ALIASES) if (re.test(s)) return alias;
    s = s.replace(/\.(COM|NET|ORG|CO|IO|TV)\b/g, ' ').replace(/[^A-Z& ]+/g, ' ');
    const tokens = s.split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
    return tokens.slice(0, 2).join(' ') || s.trim() || 'UNKNOWN';
  }

  /* ======================================================================
   * Categorisation - keyword/regex rule dictionary (edit freely)
   * Evaluated in order; first match wins. Keywords match on word boundaries,
   * case-insensitively, against the cleaned description.
   * ==================================================================== */
  const RULES = [
    { category: 'Transfers', patterns: [/payment\s*[-\u2013]?\s*thank\s*you/i, /\b(?:to|from)\s+(?:chk|sav|checking|savings)\b/i], keywords: ['payment thank you', 'autopay payment', 'online payment thank', 'credit card payment', 'card payment', 'transfer to', 'transfer from', 'online transfer', 'xfer', 'zelle', 'venmo', 'cash app', 'paypal transfer', 'internal transfer', 'savings transfer', 'directpay', 'autopay', 'epayment', 'e-payment', 'crd autopay', 'credit crd', 'card pmt', 'online pmt', 'applecard', 'amex epayment', 'card services', 'cardmember serv'] },
    { category: 'Income', sign: 'in', keywords: ['payroll', 'direct dep', 'direct deposit', 'salary', 'paycheck', 'adp', 'gusto', 'paychex', 'irs treas', 'tax refund', 'interest paid', 'interest earned', 'dividend', 'unemployment', 'social security', 'ssa treas', 'pension'] },
    { category: 'Refunds', sign: 'in', keywords: ['refund', 'return credit', 'reversal', 'chargeback', 'cashback', 'cash back reward', 'statement credit', 'rebate', 'return'] },
    { category: 'Subscriptions', keywords: ['netflix', 'spotify', 'hulu', 'disney plus', 'disneyplus', 'disney+', 'hbo max', 'max.com', 'paramount', 'peacock', 'youtube premium', 'youtube', 'apple services', 'icloud', 'apple music', 'apple tv', 'amazon prime', 'prime video', 'audible', 'kindle unlimited', 'siriusxm', 'pandora', 'tidal', 'dropbox', 'google storage', 'google one', 'microsoft 365', 'office 365', 'adobe', 'canva', 'notion', 'chatgpt', 'openai', 'patreon', 'onlyfans', 'substack', 'nytimes', 'new york times', 'wsj', 'washington post', 'medium.com', 'duolingo', 'headspace', 'calm.com', 'peloton', 'planet fitness', 'la fitness', 'gym', 'xbox game pass', 'playstation plus', 'nintendo online', 'twitch', 'crunchyroll', 'masterclass', 'linkedin premium', 'nordvpn', 'expressvpn', 'surfshark', '1password', 'lastpass', 'subscription', 'membership', 'monthly plan'] },
    { category: 'Utilities', keywords: ['electric', 'power company', 'energy', 'duke energy', 'fpl', 'pg&e', 'con ed', 'coned', 'water', 'sewer', 'gas company', 'natural gas', 'utility', 'utilities', 'waste management', 'trash', 'comcast', 'xfinity', 'spectrum', 'cox comm', 'verizon', 'at&t', 'att', 't-mobile', 'tmobile', 'sprint', 'mint mobile', 'cricket', 'boost mobile', 'google fi', 'frontier', 'centurylink', 'internet', 'broadband'] },
    { category: 'Groceries', keywords: ['grocery', 'groceries', 'supermarket', 'whole foods', 'wholefds', 'trader joe', 'trader joes', 'kroger', 'publix', 'safeway', 'albertsons', 'aldi', 'lidl', 'wegmans', 'heb', 'h-e-b', 'food lion', 'giant eagle', 'stop & shop', 'winn-dixie', 'winn dixie', 'sprouts', 'meijer', 'costco', 'sams club', "sam's club", 'bjs wholesale', 'instacart', 'fresh market', 'food 4 less', 'ralphs', 'vons', 'smart & final', 'market basket', 'save a lot', 'piggly wiggly', 'hy-vee', 'tesco', 'sainsbury', 'walmart grocery'] },
    { category: 'Dining Out', keywords: ['restaurant', 'cafe', 'coffee', 'starbucks', 'dunkin', 'mcdonald', 'burger king', 'wendy', 'taco bell', 'chipotle', 'subway', 'chick-fil-a', 'chickfila', 'popeyes', 'kfc', 'panera', 'domino', 'pizza', 'papa john', 'five guys', 'shake shack', 'in-n-out', 'sonic drive', 'dairy queen', 'panda express', 'olive garden', 'applebee', 'chili', 'ihop', 'denny', 'waffle house', 'cracker barrel', 'buffalo wild', 'sushi', 'grill', 'bistro', 'diner', 'kitchen', 'tavern', 'pub', 'brewery', 'bakery', 'doordash', 'uber eats', 'ubereats', 'grubhub', 'postmates', 'seamless', 'caviar'], patterns: [/^tst\s?\*/i] },
    { category: 'Transport', keywords: ['uber', 'lyft', 'taxi', 'cab', 'shell', 'exxon', 'mobil', 'chevron', 'bp', 'sunoco', 'marathon', 'speedway', 'wawa', 'sheetz', 'circle k', 'racetrac', 'quiktrip', 'qt', 'valero', 'citgo', '76', 'arco', 'gas station', 'fuel', 'parking', 'parkmobile', 'toll', 'e-zpass', 'ezpass', 'sunpass', 'fastrak', 'metro', 'transit', 'mta', 'bart', 'amtrak', 'greyhound', 'jiffy lube', 'auto repair', 'autozone', "o'reilly", 'advance auto', 'car wash', 'dmv'] },
    { category: 'Housing', keywords: ['rent', 'mortgage', 'landlord', 'property mgmt', 'property management', 'apartments', 'hoa', 'home depot', "lowe's", 'lowes', 'menards', 'ace hardware', 'hardware'] },
    { category: 'Health', keywords: ['pharmacy', 'cvs', 'walgreens', 'rite aid', 'doctor', 'medical', 'dental', 'dentist', 'clinic', 'hospital', 'urgent care', 'optometr', 'vision', 'labcorp', 'quest diag', 'therapy', 'physician'] },
    { category: 'Insurance', keywords: ['insurance', 'geico', 'progressive', 'state farm', 'allstate', 'liberty mutual', 'usaa', 'nationwide', 'farmers ins', 'lemonade', 'metlife', 'aflac', 'blue cross', 'aetna', 'cigna', 'humana', 'kaiser'] },
    { category: 'Debt Payment', keywords: ['loan payment', 'student loan', 'navient', 'nelnet', 'sallie mae', 'mohela', 'great lakes', 'auto loan', 'car payment', 'sofi loan', 'lending club', 'upstart', 'affirm', 'klarna', 'afterpay'] },
    { category: 'Fees & Interest', keywords: ['interest charge', 'finance charge', 'late fee', 'overdraft', 'nsf fee', 'service fee', 'monthly fee', 'maintenance fee', 'atm fee', 'foreign transaction fee', 'annual fee', 'wire fee'] },
    { category: 'Cash', keywords: ['atm withdrawal', 'atm', 'cash withdrawal'] },
    { category: 'Travel', keywords: ['airline', 'airlines', 'delta air', 'united air', 'american air', 'southwest', 'jetblue', 'spirit air', 'frontier air', 'alaska air', 'expedia', 'booking.com', 'airbnb', 'vrbo', 'hotel', 'marriott', 'hilton', 'hyatt', 'holiday inn', 'motel', 'hertz', 'enterprise rent', 'avis', 'budget rent'] },
    { category: 'Entertainment', keywords: ['cinema', 'theater', 'theatre', 'amc', 'regal', 'ticketmaster', 'stubhub', 'eventbrite', 'steam', 'playstation', 'xbox', 'nintendo', 'bowling', 'concert', 'museum'] },
    { category: 'Education', keywords: ['tuition', 'university', 'college', 'school', 'coursera', 'udemy', 'chegg', 'bookstore'] },
    { category: 'Shopping', keywords: ['amazon', 'amzn', 'amazon mktplace', 'amazon mktp', 'target', 'walmart', 'best buy', 'ebay', 'etsy', 'macy', 'kohl', 'nordstrom', 'tj maxx', 'tjmaxx', 'marshalls', 'ross stores', 'old navy', 'gap', 'h&m', 'zara', 'ikea', 'wayfair', 'dollar tree', 'dollar general', 'family dollar', 'five below', 'shein', 'temu', 'apple store', 'nike', 'sephora', 'ulta'] },
  ];

  // Pre-compile: one alternation regex per rule. Word-ish boundaries that tolerate &, ', - in keywords.
  const compileRule = (r) => ({
    ...r,
    re: r.keywords && r.keywords.length
      ? new RegExp(`(?:^|[^a-z0-9])(?:${r.keywords.map((k) => escapeRe(k.toLowerCase())).join('|')})(?=$|[^a-z0-9])`, 'i')
      : null,
  });
  let COMPILED = RULES.map(compileRule);

  /**
   * Categorise one transaction.
   * customRules: [{ match: string|RegExp, category, sign?: 'in'|'out' }] - checked before built-ins.
   */
  function categorize(description, amount, customRules = []) {
    const desc = cleanDescription(description);
    const hay = ' ' + desc.toLowerCase() + ' ';
    const raw = String(description || '');
    const dir = amount > 0 ? 'in' : 'out';
    for (const r of customRules) {
      if (r.sign && r.sign !== dir) continue;
      const hit = r.match instanceof RegExp ? r.match.test(raw) || r.match.test(desc) : hay.includes(String(r.match).toLowerCase());
      if (hit) return r.category;
    }
    for (const r of COMPILED) {
      if (r.sign && r.sign !== dir) continue;
      if ((r.re && r.re.test(hay)) || (r.patterns && r.patterns.some((p) => p.test(raw) || p.test(desc)))) return r.category;
    }
    return dir === 'in' ? 'Income' : 'Uncategorized';
  }

  /* ======================================================================
   * Recurring & subscription detection
   * ==================================================================== */
  const CADENCES = [
    { name: 'weekly', min: 6, max: 8, perMonth: 52 / 12 },
    { name: 'biweekly', min: 13, max: 16, perMonth: 26 / 12 },
    { name: 'monthly', min: 26, max: 35, perMonth: 1 },
    { name: 'bimonthly', min: 56, max: 66, perMonth: 0.5 },
    { name: 'quarterly', min: 84, max: 98, perMonth: 1 / 3 },
    { name: 'semiannual', min: 170, max: 195, perMonth: 1 / 6 },
    { name: 'yearly', min: 350, max: 380, perMonth: 1 / 12 },
  ];
  const SUBSCRIPTION_HINT = /subscription|membership|recurring|auto-?renew|autopay|monthly plan|premium|\bplus\b/i;
  const amountsClose = (a, b, tol) => Math.abs(a - b) <= Math.max(1, tol * Math.max(a, b));

  /**
   * Flags recurring transactions. `transactions` is the current batch; `history` is optional earlier
   * data (e.g. from IndexedDB) so a monthly charge seen once per statement is still caught.
   * Returns { flags: boolean[] (aligned to `transactions`), groups: RecurringGroup[] }.
   */
  function detectRecurring(transactions, { history = [], today = new Date() } = {}) {
    const all = [
      ...history.map((t) => ({ ...t, _batch: false })),
      ...transactions.map((t, i) => ({ ...t, _batch: true, _i: i })),
    ].filter((t) => t.date && isFinite(t.amount) && t.amount !== 0 && t.category !== 'Transfers' && t.type !== 'transfer');

    const byKey = new Map();
    for (const t of all) {
      const key = `${merchantKey(t.description)}|${t.amount < 0 ? 'out' : 'in'}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(t);
    }

    const flags = transactions.map(() => false);
    const groups = [];

    for (const [key, items] of byKey) {
      const [merchant, dir] = key.split('|');
      const category = items.find((t) => t._batch)?.category || items[0].category;
      const isSubCat = category === 'Subscriptions' || items.some((t) => SUBSCRIPTION_HINT.test(t.description));
      // Subscriptions drift in price (9.99 -> 10.99), so allow wider tolerance for them.
      const tol = isSubCat ? 0.25 : 0.06;

      // Cluster by amount so e.g. two different Apple subscriptions stay separate.
      const sorted = [...items].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount));
      const clusters = [];
      for (const t of sorted) {
        const c = clusters.find((cl) => amountsClose(Math.abs(t.amount), median(cl.map((x) => Math.abs(x.amount))), tol));
        c ? c.push(t) : clusters.push([t]);
      }

      for (const cluster of clusters) {
        cluster.sort((a, b) => a.date.localeCompare(b.date));
        const dates = [...new Set(cluster.map((t) => t.date))];
        const sameDayDupes = cluster.length - dates.length;
        const intervals = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
        const amounts = cluster.map((t) => Math.abs(t.amount));
        const spread = (Math.max(...amounts) - Math.min(...amounts)) / Math.max(...amounts);

        let cadence = null, confidence = null;
        if (intervals.length) {
          const med = median(intervals);
          const band = CADENCES.find((c) => med >= c.min && med <= c.max);
          if (band) {
            const inBand = intervals.filter((iv) => iv >= band.min - 2 && iv <= band.max + 2).length / intervals.length;
            if (dates.length >= 3 && inBand >= 0.66) { cadence = band; confidence = spread <= 0.02 ? 'high' : 'medium'; }
            else if (dates.length >= 3 && (inBand >= 0.5 || isSubCat)) { cadence = band; confidence = 'low'; }
            else if (dates.length === 2 && (spread <= 0.02 || isSubCat) && ['monthly', 'quarterly', 'yearly', 'semiannual', 'bimonthly'].includes(band.name)) { cadence = band; confidence = 'medium'; }
          }
        }
        // Single sighting: only trust explicit subscription signals (known service / "membership" etc.).
        if (!cadence && dir === 'out' && isSubCat) {
          cadence = CADENCES[2]; confidence = 'low';
        }
        if (!cadence || !cluster.some((t) => t._batch)) continue;
        // A $0-$1 trial/verification charge is reported on the real subscription, not as its own group.
        if (Math.max(...cluster.map((t) => Math.abs(t.amount))) <= 1 && clusters.some((c) => c !== cluster && Math.abs(c[0].amount) > 1)) continue;

        cluster.forEach((t) => { if (t._batch) flags[t._i] = true; });

        const last = cluster[cluster.length - 1];
        const lastAmt = Math.abs(last.amount);
        const avg = round2(amounts.reduce((s, a) => s + a, 0) / amounts.length);
        const intervalDays = intervals.length ? median(intervals) : 30;
        const nextExpected = toISO(new Date(parseISO(last.date).getTime() + intervalDays * 86400000));

        const reviewReasons = [];
        const prevDiff = [...cluster].reverse().find((t) => Math.abs(Math.abs(t.amount) - lastAmt) > 0.009);
        if (prevDiff && Math.abs(prevDiff.amount) < lastAmt) reviewReasons.push(`Price went up from ${Math.abs(prevDiff.amount).toFixed(2)} to ${lastAmt.toFixed(2)}`);
        if (sameDayDupes > 0) reviewReasons.push('Charged more than once on the same day');
        const firstForMerchant = [...items].sort((a, b) => a.date.localeCompare(b.date))[0];
        if (Math.abs(firstForMerchant.amount) <= 1.0 && lastAmt > 1.0 && firstForMerchant !== last) reviewReasons.push('Possible free-trial conversion (started at ' + Math.abs(firstForMerchant.amount).toFixed(2) + ')');
        const shortGap = intervals.find((iv) => iv > 0 && iv < cadence.min * 0.6);
        if (dir === 'out' && isSubCat && shortGap != null) reviewReasons.push(`Charged again after only ${shortGap} days \u2014 possibly paying twice (e.g. on two cards)`);
        const daysSince = Math.round((today - parseISO(last.date)) / 86400000);
        const active = daysSince <= intervalDays * 1.6 + 5;

        groups.push({
          merchant: merchant.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
          description: last.description,
          category,
          direction: dir,
          cadence: cadence.name,
          confidence,
          occurrences: cluster.length,
          averageAmount: avg,
          lastAmount: lastAmt,
          lastDate: last.date,
          nextExpected,
          active,
          monthlyCost: dir === 'out' ? round2(avg * cadence.perMonth) : 0,
          annualCost: dir === 'out' ? round2(avg * cadence.perMonth * 12) : 0,
          isSubscription: dir === 'out' && isSubCat,
          reviewReasons,
        });
      }
    }

    // Overlapping services: 3+ active streaming/music-type subscriptions -> suggest review.
    const activeSubs = groups.filter((g) => g.isSubscription && g.active);
    if (activeSubs.length >= 3) activeSubs.forEach((g) => g.reviewReasons.push(`One of ${activeSubs.length} active subscriptions`));
    groups.forEach((g) => { g.possiblyUnwanted = g.isSubscription && g.reviewReasons.length > 0; });
    groups.sort((a, b) => b.monthlyCost - a.monthlyCost);
    return { flags, groups };
  }

  /* ======================================================================
   * Library loading (lazy, cached)
   * ==================================================================== */
  let papaPromise = null, pdfPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = resolve; s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }
  function loadPapa() {
    if (global.Papa) return Promise.resolve(global.Papa);
    papaPromise ||= loadScript(config.libs.papaparse).then(() => {
      if (!global.Papa) throw new Error('PapaParse did not initialise');
      return global.Papa;
    }).catch((e) => { papaPromise = null; fail('LIB_LOAD_FAILED', `Could not load the CSV reader. ${navigator.onLine ? '' : 'You appear to be offline and it has not been cached yet. '}(${e.message})`); });
    return papaPromise;
  }
  function loadPdfJs() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    pdfPromise ||= import(/* webpackIgnore: true */ config.libs.pdfjs).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = config.libs.pdfWorker;
      return lib;
    }).catch((e) => { pdfPromise = null; fail('LIB_LOAD_FAILED', `Could not load the PDF reader. ${navigator.onLine ? '' : 'You appear to be offline and it has not been cached yet. '}(${e.message})`); });
    return pdfPromise;
  }

  /* ======================================================================
   * File type detection
   * ==================================================================== */
  async function sniffType(file) {
    if (!file || typeof file.arrayBuffer !== 'function') fail('UNSUPPORTED_TYPE', 'Expected a File or Blob.');
    if (file.size === 0) fail('EMPTY_FILE', `"${file.name || 'File'}" is empty.`);
    if (file.size > config.maxFileBytes) fail('FILE_TOO_LARGE', `"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${config.maxFileBytes / 1048576} MB.`);
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    const ascii = String.fromCharCode(...head.slice(0, 64));
    const name = (file.name || '').toLowerCase();
    if (ascii.includes('%PDF-')) return 'pdf';
    if (head[0] === 0x50 && head[1] === 0x4b) fail('UNSUPPORTED_TYPE', 'This looks like an Excel or ZIP file. Export the statement as CSV or PDF instead.');
    if (/OFXHEADER|<OFX>/i.test(ascii)) fail('UNSUPPORTED_TYPE', 'OFX/QFX files are not supported yet. Download the CSV or PDF version instead.');
    if (head.includes(0) && !(head[0] === 0xff || head[0] === 0xfe)) fail('UNSUPPORTED_TYPE', `"${file.name}" is not a PDF or CSV file.`);
    if (/\.(csv|tsv|txt)$/.test(name) || /csv|text|tab-separated/.test(file.type || '') || !name.includes('.')) return 'csv';
    if (name.endsWith('.pdf')) fail('PDF_INVALID', `"${file.name}" has a .pdf name but is not a valid PDF.`);
    fail('UNSUPPORTED_TYPE', `Unsupported file type: "${file.name}". Use a PDF or CSV statement.`);
  }

  /* ======================================================================
   * PDF extraction (pdf.js) -> text lines
   * ==================================================================== */
  async function extractPdfLines(file, { password, onProgress } = {}) {
    const pdfjs = await loadPdfJs();
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password, isEvalSupported: false, disableAutoFetch: true, useSystemFonts: true }).promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') {
        fail('PDF_PASSWORD', e.code === 2 ? 'Incorrect PDF password.' : 'This PDF is password-protected. Provide the password via options.password.', { needsPassword: true });
      }
      fail('PDF_INVALID', `Could not read the PDF: ${e && e.message ? e.message : e}`);
    }
    const pages = Math.min(doc.numPages, config.maxPdfPages);
    const lines = [];
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items = content.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || it.str.length * 4, h: Math.abs(it.transform[3]) || it.height || 10 }));
      // Group into visual rows by baseline (tolerance scales with font size).
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const rows = [];
      for (const it of items) {
        const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, it.h * 0.45));
        row ? row.items.push(it) : rows.push({ y: it.y, items: [it] });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        let text = '', prevEnd = null, charW = 5;
        for (const it of r.items) {
          charW = it.w / Math.max(1, it.str.length);
          if (prevEnd != null) {
            const gap = it.x - prevEnd;
            text += gap > charW * 2.5 ? '   ' : gap > charW * 0.25 ? ' ' : '';
          }
          text += it.str;
          prevEnd = it.x + it.w;
        }
        lines.push({ text: text.replace(/\s+$/, ''), page: p });
      }
      page.cleanup();
      onProgress && onProgress({ stage: 'pdf', page: p, pages });
    }
    await doc.destroy();
    if (!lines.some((l) => /[a-z]{3,}/i.test(l.text))) {
      fail('PDF_NO_TEXT', 'This PDF has no text layer (it is probably a scanned image). Download the statement as a text PDF or CSV from your bank.');
    }
    return { lines, truncated: doc.numPages > pages };
  }

  /* ======================================================================
   * PDF text -> transactions
   * ==================================================================== */
  const SKIP_LINE = /^(?:total|subtotal)\b|\b(?:beginning|opening|ending|closing|previous|new|daily|average|statement|available|current)\s+(?:ledger\s+)?balance\b|\bbalance\s+(?:forward|brought|carried)\b|^page\s+\d|minimum\s+payment\s+due|payment\s+due\s+date|credit\s+limit|^account\s+(?:number|summary)/i;
  const OPENING_BAL = /\b(?:beginning|opening|previous|starting)\s+balance\b|\bbalance\s+(?:forward|brought)/i;
  const IN_SECTION = /^(?:deposits?(?:\s+(?:and|&)\s+(?:other\s+)?(?:additions|credits))?|additions|other\s+credits|credits|payments?(?:,|\s+and|\s+&)\s+(?:other\s+)?credits|money\s+in|electronic\s+deposits|incoming(?:\s+transfers)?|interest\s+earned)\b/i;
  const OUT_SECTION = /^(?:(?:electronic\s+|atm\s+(?:and|&)\s+debit\s+card\s+|other\s+)?withdrawals?|(?:other\s+)?debits|checks(?:\s+paid)?|(?:card\s+)?purchases(?:\s+(?:and|&)\s+(?:adjustments|other\s+charges))?|fees(?:\s+charged)?|interest\s+charged|charges|money\s+out|outgoing|(?:atm|debit\s+card)\s+(?:withdrawals|transactions))\b/i;
  const CARD_PAYMENT_HINT = /payment|pymt|directpay|autopay|thank\s*you|credit\s+adj|statement\s+credit/i;
  const INCOME_HINT = /payroll|direct\s*dep|deposit|salary|refund|interest\s+(?:paid|earned)|dividend|transfer\s+from|zelle\s+from|from\s+(?:chk|sav)|reversal|cashback|credit\s+memo/i;
  const CC_CREDIT_HINT = /payment\s*(?:-|\u2013)?\s*thank|autopay|online\s+payment|payment\s+received|refund|return|credit\s+adj|statement\s+credit|reversal/i;

  function detectStatementType(text) {
    const credit = (text.match(/credit\s+limit|minimum\s+payment|available\s+credit|payment\s+due\s+date|card\s*member|new\s+balance|purchases\s+and\s+adjustments|cash\s+advance/gi) || []).length;
    const bank = (text.match(/checking|savings|deposits?\s+(?:and|&)\s+(?:other\s+)?additions|withdrawals|beginning\s+balance|ending\s+balance|routing|overdraft/gi) || []).length;
    return credit > bank ? 'credit' : 'bank';
  }

  function findStatementEnd(text, order) {
    const D = `(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|${MON}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${MON}\\s+\\d{4})`;
    const patterns = [
      new RegExp(`(?:statement|billing)\\s+(?:period|cycle)[^\\n\\d]{0,20}${D}\\s*(?:-|\u2013|to|through|thru)\\s*${D}`, 'i'),
      new RegExp(`${D}\\s*(?:-|\u2013|to|through|thru)\\s*${D}`, 'i'),
      new RegExp(`(?:closing|statement|ending|period\\s+ending)\\s+date[^\\n\\d]{0,10}${D}`, 'i'),
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const iso = parseDateToken(m[m.length - 1], { order });
        if (iso) return parseISO(iso);
      }
    }
    return null;
  }

  function parsePdfLines(lines, { order: forcedOrder, statementType: forcedType, warn }) {
    const text = lines.map((l) => l.text).join('\n');
    const type = forcedType && forcedType !== 'auto' ? forcedType : detectStatementType(text);
    const dateSamples = lines.map((l) => (l.text.match(LINE_START_DATE) || [])[1]).filter(Boolean);
    const order = forcedOrder && forcedOrder !== 'auto' ? forcedOrder : detectDateOrder(dateSamples);
    const ref = findStatementEnd(text, order) || new Date();

    const out = [];
    let section = null, prevBalance = null;

    for (const { text: line, page } of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const startMatch = trimmed.match(LINE_START_DATE);

      if (!startMatch) {
        // Section headers ("Deposits and Additions", "Purchases") switch sign context.
        if (trimmed.length < 70) {
          const plain = trimmed.replace(/\s{2,}.*$/, '');
          if (IN_SECTION.test(plain)) section = 'in';
          else if (OUT_SECTION.test(plain)) section = 'out';
        }
        if (OPENING_BAL.test(trimmed)) { const m = trimmed.match(TRAILING_MONEY); if (m) prevBalance = parseMoney(m[1])?.value ?? prevBalance; }
        continue;
      }

      const date = parseDateToken(startMatch[1], { order, ref });
      if (!date) { warn('MALFORMED_ROW', `Unrecognised date "${startMatch[1]}"`, { page, line: trimmed }); continue; }
      let rest = trimmed.slice(startMatch[0].length).trim();

      // Optional posting date right after the transaction date.
      const second = rest.match(LINE_START_DATE);
      if (second && parseDateToken(second[1], { order, ref })) rest = rest.slice(second[0].length).trim();

      if (SKIP_LINE.test(rest)) {
        if (OPENING_BAL.test(rest)) { const m = rest.match(TRAILING_MONEY); if (m) prevBalance = parseMoney(m[1])?.value ?? prevBalance; }
        continue;
      }

      // Pull money tokens off the end: [amount] or [amount, balance] (or debit, credit, balance).
      const tokens = [];
      while (tokens.length < 3) {
        const m = rest.match(TRAILING_MONEY);
        if (!m) break;
        tokens.unshift(m[1].trim());
        rest = rest.slice(0, m.index).trimEnd();
      }
      const description = rest.replace(/\s{2,}/g, ' ').trim();
      if (!tokens.length) { continue; } // dated text line without an amount (e.g. a note) - not a transaction
      if (!/[a-z]/i.test(description)) { warn('MALFORMED_ROW', 'Transaction line has no description', { page, line: trimmed }); continue; }

      const parsed = tokens.map(parseMoney);
      if (parsed.some((p) => !p)) { warn('MALFORMED_ROW', 'Could not read amount', { page, line: trimmed }); continue; }
      const amt = parsed[0];
      const balance = parsed.length >= 2 ? parsed[parsed.length - 1] : null;

      // Decide direction.
      let sign = 0;
      if (type === 'credit') {
        if (amt.explicitSign < 0 || amt.cr) sign = 1;                     // payments / credits reduce card balance
        else if (section === 'in' || CC_CREDIT_HINT.test(description)) sign = 1;
        else sign = -1;
      } else {
        if (amt.dr) sign = -1;
        else if (amt.cr) sign = 1;
        else if (amt.explicitSign < 0) sign = -1;
        if (!sign && balance && prevBalance != null) {
          if (Math.abs(prevBalance + amt.value - balance.value) < 0.015) sign = 1;
          else if (Math.abs(prevBalance - amt.value - balance.value) < 0.015) sign = -1;
        }
        if (!sign && section) sign = section === 'in' ? 1 : -1;
        if (!sign) sign = INCOME_HINT.test(description) ? 1 : -1;
      }
      if (balance) prevBalance = balance.explicitSign < 0 ? -balance.value : balance.value;
      if (amt.value === 0) continue;
      out.push({ date, rawDescription: description, amount: round2(sign * amt.value) });
    }
    // Statement balance: "New Balance" on card statements (amount owed), "Ending/Closing Balance" on bank statements.
    const balRe = type === 'credit'
      ? new RegExp('\\bnew\\s+balance\\b[^\\n\\d$(\\-]{0,40}(' + MONEY_SRC + ')', 'i')
      : new RegExp('\\b(?:ending|closing)\\s+(?:ledger\\s+)?balance\\b[^\\n\\d$(\\-]{0,40}(' + MONEY_SRC + ')', 'i');
    const bm = text.match(balRe);
    let endingBalance = null;
    if (bm) { const v = parseMoney(bm[1]); if (v) endingBalance = (v.explicitSign < 0 || v.cr) ? -v.value : v.value; }
    return { rows: out, meta: { statementType: type, dateOrder: order, statementEnd: toISO(ref), endingBalance, endingBalanceDate: endingBalance != null ? toISO(ref) : null, datedLines: dateSamples.length, looksLikeStatement: /balance|statement|account|payment|deposit|withdrawal|purchase/i.test(text) } };
  }

  /* ======================================================================
   * CSV extraction (PapaParse) -> transactions
   * ==================================================================== */
  function papaParseFile(Papa, file) {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: false,
        skipEmptyLines: 'greedy',
        dynamicTyping: false,
        worker: false,
        complete: (res) => resolve(res),
        error: (err) => reject(new StatementParserError('CSV_INVALID', `Could not read CSV: ${err.message || err}`)),
      });
    });
  }

  const H = {
    date: /^(?:datum|fecha|data|buchungstag|valuta|date\s+op[\u00e9e]ration)$|^(?:trans(?:action)?\.?\s*)?date$|^date\b|transaction\s+date|trans\.?\s+date|posted\s+date|posting\s+date|post\s+date|value\s+date|^posted$|^date\s*\/?\s*time/i,
    description: /omschrijving|libell[\u00e9e]|concepto|verwendungszweck|buchungstext|descri|tegenpartij|beneficiario|desc|payee|merchant|^name$|memo|details|narrative|particulars|transaction$|^reference$/i,
    amount: /^(?:bedrag|montant|importe|betrag|importo|valor|belopp|bel[\u00f8o]b)$|^(?:transaction\s+)?amount|amount$|^value$|^sum$|^amt$/i,
    debit: /debit|withdrawal|money\s+out|paid\s+out|^charges?$|^out$/i,
    credit: /credit|deposit|money\s+in|paid\s+in|^in$|^payments?$/i,
    type: /^(?:type|transaction\s+type|dr\s*\/\s*cr|cr\s*\/\s*dr|debit\s*\/\s*credit|credit\s*\/\s*debit|direction)$/i,
    category: /categ/i,
    balance: /balance/i,
  };

  function locateHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const cells = rows[i].map((c) => String(c || '').trim());
      const hasDate = cells.some((c) => H.date.test(c));
      const hasOther = cells.some((c) => H.amount.test(c) || H.debit.test(c) || H.credit.test(c) || H.description.test(c));
      const hasMoney = cells.some((c) => /^[-($]*\d[\d,]*\.\d{2}\)?$/.test(c));
      if (hasDate && hasOther && !hasMoney) return i;
    }
    return -1;
  }

  function mapColumnsFromHeader(header) {
    const idx = (re, exclude = []) => header.findIndex((h, i) => re.test(h) && !exclude.includes(i) && !H.balance.test(h));
    const cols = {};
    // Prefer "Transaction Date" over "Post Date" when both exist.
    const txDate = header.findIndex((h) => /trans(?:action)?\.?\s*date/i.test(h));
    cols.date = txDate >= 0 ? txDate : idx(H.date);
    cols.type = idx(H.type);
    cols.category = idx(H.category);
    cols.debit = idx(H.debit, [cols.type]);
    cols.credit = idx(H.credit, [cols.type, cols.debit]);
    cols.amount = idx(H.amount, [cols.debit, cols.credit]);
    if (cols.debit >= 0 && cols.credit >= 0 && cols.amount >= 0 && /debit|credit/i.test(header[cols.amount])) cols.amount = -1;
    cols.description = idx(H.description, [cols.date, cols.amount, cols.debit, cols.credit, cols.type, cols.category]);
    cols.balance = header.findIndex((h) => H.balance.test(h) && !/available/i.test(h));
    return cols;
  }

  /** Header-less files: infer columns from content. */
  function inferColumns(rows, order) {
    const sample = rows.slice(0, 50);
    const width = Math.max(...sample.map((r) => r.length));
    const stats = Array.from({ length: width }, (_, c) => {
      const vals = sample.map((r) => String(r[c] ?? '').trim()).filter(Boolean);
      const n = vals.length || 1;
      return {
        date: vals.filter((v) => parseDateToken(v, { order })).length / n,
        money: vals.filter((v) => /^[-+($\u20ac\u00a3]*\s?\d[\d,.]*\d?\)?\s*(?:CR|DR)?$/i.test(v) && parseMoney(v)).length / n,
        letters: vals.reduce((s, v) => s + (v.match(/[a-z]/gi) || []).length, 0) / n,
        filled: vals.length / sample.length,
      };
    });
    const best = (key, exclude, min) => { let b = -1, bv = min; stats.forEach((s, i) => { if (!exclude.includes(i) && s[key] > bv) { bv = s[key]; b = i; } }); return b; };
    const date = best('date', [], 0.6);
    const amount = best('money', [date], 0.6);
    const description = best('letters', [date, amount], 1.5);
    return { date, amount, description, debit: -1, credit: -1, type: -1, category: -1 };
  }

  async function parseCsvFile(file, { order: forcedOrder, invertAmounts, accountType, warn, onProgress }) {
    const Papa = await loadPapa();
    let res;
    try { res = await papaParseFile(Papa, file); }
    catch (e) { throw e instanceof StatementParserError ? e : new StatementParserError('CSV_INVALID', e.message); }
    const rows = (res.data || []).filter((r) => Array.isArray(r) && r.some((c) => !isBlank(c)));
    (res.errors || []).slice(0, 20).forEach((e) => warn('CSV_ROW_ERROR', e.message, { row: e.row != null ? e.row + 1 : undefined }));
    if (rows.length === 0) fail('EMPTY_FILE', `"${file.name}" contains no rows.`);
    onProgress && onProgress({ stage: 'csv', rows: rows.length });

    const hIdx = locateHeader(rows);
    const header = hIdx >= 0 ? rows[hIdx].map((c) => String(c || '').trim()) : null;
    let body = rows.slice(hIdx + 1);
    let firstRowNo = hIdx + 2; // 1-based row number of body[0] (ignores blank lines skipped by PapaParse)
    let cols = header ? mapColumnsFromHeader(header) : null;
    const order0 = forcedOrder && forcedOrder !== 'auto' ? forcedOrder : detectDateOrder(body.map((r) => r[cols && cols.date >= 0 ? cols.date : 0]));
    if (!cols || cols.date < 0 || (cols.amount < 0 && cols.debit < 0 && cols.credit < 0)) {
      const inferred = inferColumns(body, order0);
      cols = { ...inferred, ...(cols ? Object.fromEntries(Object.entries(cols).filter(([, v]) => v >= 0)) : {}) };
    }
    if (cols.date < 0) fail('CSV_INVALID', 'Could not find a date column in this CSV.');
    // Unrecognised header row (e.g. another language): drop a first row whose date cell isn't a date.
    if (hIdx < 0 && body.length > 1 && !parseDateToken(body[0][cols.date], { order: order0 }) && parseDateToken(body[1][cols.date], { order: order0 })) { body.shift(); firstRowNo++; }
    if (cols.amount < 0 && cols.debit < 0 && cols.credit < 0) fail('CSV_INVALID', 'Could not find an amount column in this CSV.');
    const order = forcedOrder && forcedOrder !== 'auto' ? forcedOrder : detectDateOrder(body.map((r) => r[cols.date]));

    const parsedRows = [];
    body.forEach((r, i) => {
      const rowNo = firstRowNo + i;
      const rawDate = r[cols.date];
      const date = parseDateToken(rawDate, { order });
      if (!date) { warn('MALFORMED_ROW', isBlank(rawDate) ? 'Missing date' : `Unrecognised date "${rawDate}"`, { row: rowNo }); return; }

      let amount = null;
      if (cols.amount >= 0 && !isBlank(r[cols.amount])) {
        const m = parseMoney(r[cols.amount]);
        if (m) amount = (m.explicitSign < 0 || m.dr ? -1 : 1) * m.value;
      }
      if (amount == null && (cols.debit >= 0 || cols.credit >= 0)) {
        const d = cols.debit >= 0 ? parseMoney(r[cols.debit]) : null;
        const c = cols.credit >= 0 ? parseMoney(r[cols.credit]) : null;
        if (d || c) amount = (c ? c.value : 0) - (d ? d.value : 0);
      }
      if (amount != null && cols.type >= 0) {
        const t = String(r[cols.type] || '').trim();
        if (/^(?:debit|dr|withdrawal|purchase|sale|payment\s+out|out)/i.test(t)) amount = -Math.abs(amount);
        else if (/^(?:credit|cr|deposit|refund|return|in)/i.test(t)) amount = Math.abs(amount);
      }
      if (amount == null || !isFinite(amount)) { warn('MALFORMED_ROW', 'Missing or unreadable amount', { row: rowNo }); return; }
      if (amount === 0) return;

      const descParts = cols.description >= 0 ? [r[cols.description]] : [];
      const rawDescription = String(descParts.join(' ') || '').trim();
      if (!rawDescription) { warn('MALFORMED_ROW', 'Empty description', { row: rowNo }); }
      const bal = cols.balance >= 0 ? parseMoney(r[cols.balance]) : null;
      parsedRows.push({ date, rawDescription: rawDescription || '(no description)', amount: round2(amount), bankCategory: cols.category >= 0 ? String(r[cols.category] || '').trim() : '', balance: bal ? (bal.explicitSign < 0 ? -bal.value : bal.value) : null });
    });

    // Sign convention out of here: negative = money out / card charge, positive = money in / card payment or credit.
    let inverted = false;
    const isPay = (t) => CARD_PAYMENT_HINT.test(t.rawDescription) || /payment|credit/i.test(t.bankCategory || '');
    if (invertAmounts != null) inverted = !!invertAmounts;
    else if (accountType === 'credit') {
      // Issuers disagree (Chase: purchases negative; Amex/Discover: purchases positive).
      // Whichever sign most non-payment rows carry is the "charge" sign.
      const others = parsedRows.filter((t) => !isPay(t)), pay = parsedRows.filter(isPay);
      const pos = others.filter((t) => t.amount > 0).length, neg = others.length - pos;
      if (pos > neg) inverted = true;
      else if (pos === neg && pay.length && pay.every((t) => t.amount < 0)) inverted = true;
    } else if (accountType === 'bank') {
      inverted = false; // bank exports: deposits positive, withdrawals negative (or split debit/credit columns)
    } else if (parsedRows.length >= 3) {
      const pay = parsedRows.filter(isPay);
      const others = parsedRows.filter((t) => !isPay(t));
      const posShare = others.filter((t) => t.amount > 0).length / Math.max(1, others.length);
      if (pay.length && pay.every((t) => t.amount < 0) && posShare > 0.6) inverted = true;
      else if (!pay.length && posShare > 0.9 && parsedRows.length >= 5 && !parsedRows.some((t) => t.amount > 0 && INCOME_HINT.test(t.rawDescription))) inverted = true;
    }
    if (inverted) parsedRows.forEach((t) => { t.amount = -t.amount; });

    // Ending balance from a running-balance column (newest row; files may be newest-first or oldest-first).
    let endingBalance = null, endingBalanceDate = null;
    const withBal = parsedRows.filter((t) => t.balance != null);
    if (withBal.length) {
      const newestFirst = withBal.length > 1 && withBal[0].date > withBal[withBal.length - 1].date;
      const last = newestFirst ? withBal[0] : withBal[withBal.length - 1];
      endingBalance = round2(accountType === 'credit' ? Math.abs(last.balance) : last.balance); endingBalanceDate = last.date;
    }
    return { rows: parsedRows, meta: { dateOrder: order, columns: cols, headerRow: hIdx >= 0 ? hIdx + 1 : null, amountsInverted: inverted, statementType: accountType || (inverted ? 'credit' : 'bank'), endingBalance, endingBalanceDate } };
  }

  /* ======================================================================
   * Storage - IndexedDB (shares the Centric Wealth database)
   * ==================================================================== */
  // Must match the app's FinanceDB schema so either can create the database first.
  const APP_SCHEMA = {
    transactions: { keyPath: 'id', indexes: [['date', 'date'], ['type', 'type'], ['category', 'category'], ['hash', 'hash']] },
    debts: { keyPath: 'id', indexes: [] },
    bills: { keyPath: 'id', indexes: [['active', 'active']] },
    budgets: { keyPath: 'category', indexes: [] },
    accounts: { keyPath: 'id', indexes: [] },
    settings: { keyPath: 'key', indexes: [] },
  };

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new StatementParserError('STORAGE_UNAVAILABLE', 'IndexedDB is not available (private browsing may block it).'));
      const upgrade = (db, tx) => {
        for (const [name, def] of Object.entries(APP_SCHEMA)) {
          const store = db.objectStoreNames.contains(name) ? tx.objectStore(name) : db.createObjectStore(name, { keyPath: def.keyPath });
          for (const [idx, path] of def.indexes) if (!store.indexNames.contains(idx)) store.createIndex(idx, path, { unique: false });
        }
      };
      // Open at whatever version exists (the app may have migrated); upgrade only if our store is missing.
      const req = indexedDB.open(config.db.name);
      req.onupgradeneeded = () => upgrade(req.result, req.transaction);
      req.onerror = () => reject(new StatementParserError('STORAGE_UNAVAILABLE', `Could not open local database: ${req.error && req.error.message}`));
      req.onsuccess = () => {
        const db = req.result;
        if (db.objectStoreNames.contains(config.db.store)) return resolve(db);
        const v = db.version + 1; db.close();
        const up = indexedDB.open(config.db.name, v);
        up.onupgradeneeded = () => upgrade(up.result, up.transaction);
        up.onsuccess = () => resolve(up.result);
        up.onerror = () => reject(new StatementParserError('STORAGE_UNAVAILABLE', `Could not upgrade local database: ${up.error && up.error.message}`));
        up.onblocked = () => reject(new StatementParserError('STORAGE_UNAVAILABLE', 'Database upgrade blocked \u2014 close other tabs of this app.'));
      };
    });
  }

  async function getStoredTransactions() {
    if (global.FinanceDB && global.FinanceDB.getAll) return global.FinanceDB.getAll(config.db.store);
    const db = await openDB();
    try {
      return await new Promise((res, rej) => { const r = db.transaction(config.db.store).objectStore(config.db.store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    } finally { db.close(); }
  }

  // Same hash the app uses (date | abs amount | lower-cased description), so imports from either path de-duplicate.
  function hashTx(date, absAmount, description) {
    const s = `${date}|${round2(absAmount)}|${String(description || '').toLowerCase().trim()}`;
    let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h);
  }

  // Parser categories -> the app's category list.
  const APP_CATEGORY = {
    'Dining Out': 'Dining', 'Uncategorized': 'Other', 'Fees & Interest': 'Other', 'Cash': 'Other', 'Transfers': 'Other', 'Refunds': 'Refund',
  };
  const toAppCategory = (cat, amount, desc) => {
    if (amount > 0) {
      if (cat === 'Income') return /payroll|salary|direct\s*dep|paycheck/i.test(desc) ? 'Salary' : /interest|dividend/i.test(desc) ? 'Interest' : 'Other Income';
      if (cat === 'Refunds') return 'Refund';
      return 'Other Income';
    }
    return APP_CATEGORY[cat] || cat;
  };

  const uid = () => (global.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  /**
   * Save transactions, skipping ones already stored. Identical rows within one file (two $5 coffees
   * the same day) are kept: the nth copy gets a "#n" hash suffix and only extra copies are inserted.
   */
  const CARD_PAY_OUT = /card|crd|amex|american\s+express|discover|capital\s+one|citi|barclay|synchrony|apple\s*card|applecard|e-?payment|autopay|cardmember/i;

  /**
   * How a statement row is stored in the app, by account type:
   *   bank:   deposit -> income, withdrawal -> expense, moves between own accounts -> transfer
   *           (a payment to a credit card is a transfer "Card Payment", so spending isn't counted twice)
   *   credit: charge -> expense (raises the amount owed); payment / refund / statement credit ->
   *           transfer "Card Payment" / "Card Credit" (a balance adjustment that lowers the amount owed)
   */
  function classify(t, accountType) {
    const out = t.amount < 0;
    if (accountType === 'credit') {
      if (out) return { type: 'expense', category: toAppCategory(t.category, t.amount, t.description) };
      const isPayment = CARD_PAYMENT_HINT.test(t.description) || t.category === 'Transfers';
      return { type: 'transfer', category: isPayment ? 'Card Payment' : 'Card Credit' };
    }
    if (t.category === 'Transfers') return { type: 'transfer', category: out && CARD_PAY_OUT.test(t.description) ? 'Card Payment' : 'Transfer' };
    return { type: out ? 'expense' : 'income', category: toAppCategory(t.category, t.amount, t.description) };
  }
  const sameAccount = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

  async function saveTransactions(transactions, { sourceName = '', accountType = null, accountName = '' } = {}) {
    if (accountType && accountType !== 'bank' && accountType !== 'credit') fail('UNSUPPORTED_TYPE', 'accountType must be "bank" or "credit".');
    const existing = await getStoredTransactions();
    const have = new Map();
    // Duplicates are checked within the same account, so the same $500 card payment can appear on both statements.
    for (const t of existing) { if (!sameAccount(t.accountName, accountName)) continue; const base = String(t.hash || '').split('#')[0]; if (base) have.set(base, (have.get(base) || 0) + 1); }
    const seen = new Map();
    const now = new Date().toISOString();
    const records = [];
    for (const t of transactions) {
      const base = hashTx(t.date, Math.abs(t.amount), t.description);
      const n = (seen.get(base) || 0) + 1; seen.set(base, n);
      if (n <= (have.get(base) || 0)) continue; // already imported
      records.push({
        // Transfers (card payments, moves between own accounts) get their own type so they don't inflate income/expense totals.
        id: uid(), ...classify(t, accountType || 'bank'), direction: t.amount < 0 ? 'out' : 'in', amount: round2(Math.abs(t.amount)),
        statementCategory: t.category, accountType: accountType || null, accountName: String(accountName || '').trim(),
        date: t.date, description: t.description, isRecurring: t.isRecurring,
        source: 'statement', importedFrom: sourceName, hash: n === 1 ? base : `${base}#${n}`, createdAt: now, updatedAt: now,
      });
    }
    if (!records.length) return { inserted: 0, skippedDuplicates: transactions.length };
    try {
      if (global.FinanceDB && global.FinanceDB.bulkPut) await global.FinanceDB.bulkPut(config.db.store, records);
      else {
        const db = await openDB();
        try {
          await new Promise((res, rej) => {
            const tx = db.transaction(config.db.store, 'readwrite');
            const store = tx.objectStore(config.db.store);
            records.forEach((r) => store.put(r));
            tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Transaction aborted'));
          });
        } finally { db.close(); }
      }
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') fail('STORAGE_FAILED', 'Device storage is full. Free some space or export and clear old data.');
      throw e instanceof StatementParserError ? e : new StatementParserError('STORAGE_FAILED', `Could not save transactions: ${e && e.message}`);
    }
    return { inserted: records.length, skippedDuplicates: transactions.length - records.length };
  }

  /* ======================================================================
   * Public pipeline
   * ==================================================================== */
  /**
   * @param {File|Blob} file
   * @param {object} [options]
   *   accountType    'bank' | 'credit'   how to read signs and how rows are stored (see classify)
   *   accountName    label saved on every transaction, e.g. 'Chase Checking'
   *   persist        (true)   save to IndexedDB
   *   useHistory     (true)   include stored transactions when detecting recurring charges
   *   password       PDF password
   *   dateOrder      'auto' | 'MDY' | 'DMY'
   *   statementType  'auto' | 'bank' | 'credit'   (PDF sign handling)
   *   invertAmounts  true/false to force CSV sign flip (default: auto-detect)
   *   customRules    [{ match: string|RegExp, category, sign?: 'in'|'out' }]
   *   onProgress     ({stage, ...}) => void
   *   onWarning      ({code, message, row?, page?, line?}) => void
   */
  async function parseStatementDetailed(file, options = {}) {
    const opts = { persist: true, useHistory: true, dateOrder: 'auto', statementType: 'auto', customRules: [], ...options };
    if (opts.accountType === 'bank' || opts.accountType === 'credit') opts.statementType = opts.accountType;
    const warnings = [];
    const warn = (code, message, extra = {}) => {
      const w = { code, message, ...extra };
      if (warnings.length < 500) warnings.push(w);
      try { opts.onWarning && opts.onWarning(w); } catch (_) {}
    };

    const kind = await sniffType(file);
    let rows, meta;
    if (kind === 'pdf') {
      const { lines, truncated } = await extractPdfLines(file, { password: opts.password, onProgress: opts.onProgress });
      if (truncated) warn('PDF_TRUNCATED', `Only the first ${config.maxPdfPages} pages were read.`);
      ({ rows, meta } = parsePdfLines(lines, { order: opts.dateOrder, statementType: opts.statementType, warn }));
    } else {
      ({ rows, meta } = await parseCsvFile(file, { order: opts.dateOrder, invertAmounts: opts.invertAmounts, accountType: opts.accountType, warn, onProgress: opts.onProgress }));
    }
    if (!rows.length) {
      // A PDF with no lines that start with a date is almost certainly not a statement (a letter, a guide, a receipt).
      const notStatement = kind === 'pdf' && !meta.datedLines;
      fail('NO_TRANSACTIONS', notStatement
        ? `"${file.name}" doesn't look like a bank or credit card statement: it has no lines that start with a date and end with an amount. Download the statement itself from your bank's website (PDF or CSV).`
        : `No transactions were found in "${file.name}". ${kind === 'pdf' ? 'The layout may not be supported \u2014 try the CSV download from your bank.' : 'Check that the file has date and amount columns.'}`, { warnings, notStatement });
    }

    // Clean + categorise.
    let transactions = rows.map((r) => {
      const description = cleanDescription(r.rawDescription);
      let category = categorize(r.rawDescription, r.amount, opts.customRules);
      if (category === 'Uncategorized' && r.bankCategory) {
        const viaBank = categorize(r.bankCategory, r.amount, opts.customRules);
        if (viaBank !== 'Uncategorized') category = viaBank;
      }
      return { date: r.date, description, amount: r.amount, category, isRecurring: false };
    });
    transactions.sort((a, b) => a.date.localeCompare(b.date));

    // Recurring detection with optional stored history.
    let history = [];
    if (opts.useHistory) {
      try {
        history = (await getStoredTransactions()).map((t) => ({ date: t.date, description: t.description, amount: (t.type === 'expense' || t.direction === 'out') ? -Math.abs(t.amount) : Math.abs(t.amount), category: t.statementCategory || t.category, type: t.type }));
        // Don't count this same file twice if it was imported before.
        const batch = new Set(transactions.map((t) => `${t.date}|${round2(Math.abs(t.amount))}|${t.description.toLowerCase()}`));
        history = history.filter((t) => !batch.has(`${t.date}|${round2(Math.abs(t.amount))}|${String(t.description).toLowerCase()}`));
      } catch (e) { warn('HISTORY_UNAVAILABLE', `Recurring detection ran without stored history: ${e.message}`); }
    }
    const { flags, groups } = detectRecurring(transactions, { history });
    transactions = transactions.map((t, i) => ({ ...t, isRecurring: flags[i] }));

    let saved = null;
    if (opts.persist) {
      try { saved = await saveTransactions(transactions, { sourceName: file.name, accountType: opts.accountType, accountName: opts.accountName }); }
      catch (e) { e.transactions = transactions; e.recurring = groups; e.warnings = warnings; throw e; }
    }

    return {
      transactions,
      recurring: groups,
      warnings,
      saved,
      meta: { fileName: file.name, fileType: kind, transactionCount: transactions.length, dateRange: [transactions[0].date, transactions[transactions.length - 1].date], ...meta },
    };
  }

  /** Spec-shaped result: [{ date, description, amount, category, isRecurring }] (persisted by default). */
  async function parseStatement(file, options = {}) {
    const { transactions } = await parseStatementDetailed(file, options);
    return transactions;
  }

  /** Parse several files; failures are collected per file instead of aborting the batch. */
  async function parseFiles(files, options = {}) {
    const results = [];
    for (const file of Array.from(files)) {
      try { results.push({ file: file.name, ok: true, ...(await parseStatementDetailed(file, options)) }); }
      catch (e) { results.push({ file: file.name, ok: false, error: { code: e.code || 'UNKNOWN', message: e.message } }); }
    }
    return results;
  }

  /** Wire a drop zone / <input type=file>. handlers: { onResult(report, file), onError(err, file), options } */
  function attachDropZone(el, { onResult, onError, options } = {}) {
    const handle = async (fileList) => {
      for (const f of Array.from(fileList || [])) {
        try { onResult && onResult(await parseStatementDetailed(f, options), f); }
        catch (e) { onError ? onError(e, f) : console.error(e); }
      }
    };
    if (el.tagName === 'INPUT') { el.addEventListener('change', () => { handle(el.files); el.value = ''; }); return; }
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('is-dragover'); });
    el.addEventListener('dragleave', () => el.classList.remove('is-dragover'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('is-dragover'); handle(e.dataTransfer.files); });
  }

  global.StatementParser = {
    version: '1.0.0',
    config,
    parseStatement,
    parseStatementDetailed,
    parseFiles,
    attachDropZone,
    // Building blocks (exposed for custom UIs and tests)
    categorize,
    detectRecurring,
    cleanDescription,
    merchantKey,
    parseDateToken,
    parseMoney,
    hashTx,
    classify,
    saveTransactions,
    getStoredTransactions,
    RULES,
    /** Replace or extend the built-in rule dictionary at runtime. */
    setRules(rules) { RULES.length = 0; RULES.push(...rules); COMPILED = RULES.map(compileRule); },
    StatementParserError,
  };
})(typeof window !== 'undefined' ? window : globalThis);
