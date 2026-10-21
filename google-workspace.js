/*!
 * Centric Wealth - GoogleWorkspace
 * Gmail bill scanning and Google Drive report export, entirely from the browser.
 *
 *   Sign-in:  Google Identity Services (GIS) token client - https://accounts.google.com/gsi/client
 *   API calls: Google API client library (gapi.client.request) - https://apis.google.com/js/api.js
 *   (gapi.auth2 was retired by Google, so tokens come from GIS and are handed to gapi.)
 *
 * Setup (once): create an OAuth 2.0 Client ID of type "Web application" in Google Cloud Console,
 * add your site (e.g. https://yourname.github.io) under "Authorized JavaScript origins", enable the
 * Gmail API and Google Drive API, and paste the Client ID into Settings. No client secret is used.
 *
 *   GoogleWorkspace.configure({ clientId });
 *   await GoogleWorkspace.connect();                       // from a click: opens Google's consent popup
 *   const found = await GoogleWorkspace.gmail.scanBills({ days: 30 });
 *   const md = GoogleWorkspace.buildMonthlyReport(data, '2026-10', 'md');
 *   await GoogleWorkspace.drive.saveReport({ month: '2026-10', format: 'md', content: md });
 *   const reports = await GoogleWorkspace.drive.listReports();
 *
 * The access token lives in sessionStorage: scoped to this site and this tab, gone when the tab
 * closes, and valid for about an hour. Email contents are processed in the browser; only Google's
 * own APIs are contacted.
 */
(function (global) {
  'use strict';

  const SCOPES = {
    gmail: 'https://www.googleapis.com/auth/gmail.readonly',
    drive: 'https://www.googleapis.com/auth/drive.file',
  };
  const LIBS = { gis: 'https://accounts.google.com/gsi/client', gapi: 'https://apis.google.com/js/api.js' };
  const TOKEN_KEY = 'cw.google.token';
  const REPORT_FOLDER = 'Centric Wealth Reports';
  const APP_TAG = 'centricWealth';

  /* ============================================================ errors */
  class GoogleError extends Error {
    constructor(code, message, extra) { super(message); this.name = 'GoogleError'; this.code = code; Object.assign(this, extra || {}); }
  }
  /** What the UI should offer for each error code. */
  const ERROR_ACTION = {
    NOT_CONFIGURED: 'setup', LIB_LOAD_FAILED: 'retry', POPUP_BLOCKED: 'reconnect', POPUP_CLOSED: 'reconnect', ACCESS_DENIED: 'reconnect',
    NOT_CONNECTED: 'reconnect', TOKEN_EXPIRED: 'reconnect', MISSING_SCOPE: 'reconnect', API_DISABLED: 'setup',
    RATE_LIMIT: 'retry', NETWORK: 'retry', NOT_FOUND: 'none', API_ERROR: 'retry',
  };

  /* ============================================================= state */
  const events = new EventTarget();
  const state = { clientId: '', loaded: false, token: null, email: '', status: 'disconnected', lastError: null };
  let tokenClient = null, loadPromise = null, pendingAuth = null;

  function emit() { events.dispatchEvent(new Event('change')); }
  function setStatus(status, err) { state.status = status; state.lastError = err || null; emit(); }

  function readToken() {
    try { const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null'); return t && t.access_token ? t : null; } catch (_) { return null; }
  }
  function writeToken(t) {
    try { t ? sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t)) : sessionStorage.removeItem(TOKEN_KEY); } catch (_) {}
  }
  const tokenValid = (t) => !!t && Date.now() < t.expires_at - 60 * 1000; // 1-minute safety margin
  const hasScope = (t, s) => !!t && String(t.scope || '').split(' ').includes(s);

  /* ======================================================== libraries */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing && existing.dataset.loaded) return resolve();
      const s = existing || document.createElement('script');
      s.src = src; s.async = true; s.defer = true;
      s.onload = () => { s.dataset.loaded = '1'; resolve(); };
      s.onerror = () => reject(new GoogleError('LIB_LOAD_FAILED', navigator.onLine ? 'Could not load Google sign-in. Check that nothing is blocking accounts.google.com and apis.google.com.' : 'You are offline. Google features need an internet connection.'));
      if (!existing) document.head.appendChild(s);
    });
  }

  /** Loads GIS + gapi client once. */
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      await Promise.all([loadScript(LIBS.gis), loadScript(LIBS.gapi)]);
      await new Promise((resolve, reject) => global.gapi.load('client', { callback: resolve, onerror: () => reject(new GoogleError('LIB_LOAD_FAILED', 'Google API client failed to start.')), timeout: 15000, ontimeout: () => reject(new GoogleError('LIB_LOAD_FAILED', 'Google API client timed out.')) }));
      await global.gapi.client.init({});
      state.loaded = true;
      const t = readToken();
      if (tokenValid(t)) { state.token = t; global.gapi.client.setToken({ access_token: t.access_token }); }
    })().catch((e) => { loadPromise = null; throw e instanceof GoogleError ? e : new GoogleError('LIB_LOAD_FAILED', e.message || String(e)); });
    return loadPromise;
  }

  function ensureTokenClient() {
    if (!state.clientId) throw new GoogleError('NOT_CONFIGURED', 'Add your Google OAuth Client ID in Settings first.');
    if (tokenClient && tokenClient._clientId === state.clientId) return tokenClient;
    tokenClient = global.google.accounts.oauth2.initTokenClient({
      client_id: state.clientId,
      scope: [SCOPES.gmail, SCOPES.drive].join(' '),
      include_granted_scopes: true,
      callback: (resp) => {
        const p = pendingAuth; pendingAuth = null;
        if (!p) return;
        if (resp.error) return p.reject(new GoogleError(resp.error === 'access_denied' ? 'ACCESS_DENIED' : 'API_ERROR', resp.error === 'access_denied' ? 'Google access was not granted.' : (resp.error_description || resp.error)));
        p.resolve(resp);
      },
      error_callback: (err) => {
        const p = pendingAuth; pendingAuth = null;
        if (!p) return;
        const type = err && err.type;
        p.reject(new GoogleError(type === 'popup_failed_to_open' ? 'POPUP_BLOCKED' : 'POPUP_CLOSED',
          type === 'popup_failed_to_open' ? 'The Google sign-in window was blocked. Allow pop-ups for this site and try again.' : 'The Google sign-in window was closed before finishing.'));
      },
    });
    tokenClient._clientId = state.clientId;
    return tokenClient;
  }

  /* ============================================================== auth */
  function configure({ clientId } = {}) {
    const id = String(clientId || '').trim();
    if (id !== state.clientId) { state.clientId = id; tokenClient = null; }
    const t = readToken();
    if (tokenValid(t)) { state.token = t; state.email = t.email || ''; setStatus('connected'); }
    else if (t) { state.token = t; setStatus('expired'); }
    else setStatus(id ? 'disconnected' : 'not-configured');
  }

  /**
   * Opens Google's consent popup. Call directly from a click/tap handler (browsers block popups otherwise).
   * Resolves with { email, scopes: { gmail, drive } }.
   */
  async function connect({ reauth = false } = {}) {
    await load();
    const client = ensureTokenClient();
    setStatus('connecting');
    try {
      const resp = await new Promise((resolve, reject) => {
        pendingAuth = { resolve, reject };
        // First time: full consent screen. Re-auth: Google skips it if access is already granted.
        client.requestAccessToken({ prompt: reauth && state.email ? '' : 'consent', hint: state.email || undefined });
      });
      const token = { access_token: resp.access_token, scope: resp.scope || '', expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000, email: state.email };
      state.token = token; global.gapi.client.setToken({ access_token: token.access_token });
      writeToken(token);
      try { state.email = await whoAmI(); token.email = state.email; writeToken(token); } catch (_) {}
      setStatus('connected');
      return { email: state.email, scopes: grantedScopes() };
    } catch (e) {
      setStatus(state.token && tokenValid(state.token) ? 'connected' : state.token ? 'expired' : 'disconnected', e);
      throw e;
    }
  }

  async function whoAmI() {
    if (hasScope(state.token, SCOPES.gmail)) return (await request({ path: '/gmail/v1/users/me/profile' })).emailAddress || '';
    return ((await request({ path: '/drive/v3/about', params: { fields: 'user(emailAddress)' } })).user || {}).emailAddress || '';
  }

  /** Revokes the token at Google and forgets it locally. */
  async function disconnect() {
    const t = state.token;
    state.token = null; state.email = ''; writeToken(null);
    try { if (t && global.google && global.google.accounts) global.google.accounts.oauth2.revoke(t.access_token, () => {}); } catch (_) {}
    try { global.gapi && global.gapi.client && global.gapi.client.setToken(null); } catch (_) {}
    setStatus(state.clientId ? 'disconnected' : 'not-configured');
  }

  function grantedScopes() { return { gmail: hasScope(state.token, SCOPES.gmail), drive: hasScope(state.token, SCOPES.drive) }; }

  function getStatus() {
    if (state.token && !tokenValid(state.token) && state.status === 'connected') state.status = 'expired';
    return {
      status: state.status, configured: !!state.clientId, email: state.email,
      scopes: grantedScopes(),
      expiresInMinutes: state.token ? Math.max(0, Math.round((state.token.expires_at - Date.now()) / 60000)) : 0,
      lastError: state.lastError,
    };
  }

  /* =========================================================== requests */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function normalizeError(err) {
    if (err instanceof GoogleError) return err;
    const status = err && (err.status || (err.result && err.result.error && err.result.error.code));
    const e = (err && err.result && err.result.error) || {};
    const reason = (e.errors && e.errors[0] && e.errors[0].reason) || (e.details && e.details[0] && e.details[0].reason) || e.status || '';
    const msg = e.message || (err && err.message) || 'Google request failed.';
    if (!status || status <= 0) return new GoogleError('NETWORK', navigator.onLine ? 'Could not reach Google. Check your connection and try again.' : 'You are offline. Connect to the internet and try again.');
    if (status === 401) return new GoogleError('TOKEN_EXPIRED', 'Your Google session expired. Re-authenticate to continue.');
    if (status === 429 || /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED|quotaExceeded/i.test(reason)) return new GoogleError('RATE_LIMIT', 'Google is limiting requests right now. Wait a minute and try again.', { status, reason });
    if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|PERMISSION_DENIED/i.test(reason + msg)) return new GoogleError('MISSING_SCOPE', 'This needs a permission that wasn\'t granted. Re-authenticate and tick both Gmail and Drive.', { status, reason });
    if (status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(reason + msg)) return new GoogleError('API_DISABLED', 'This API is not enabled in your Google Cloud project. Enable the Gmail API and Google Drive API, then try again.', { status, reason });
    if (status === 404) return new GoogleError('NOT_FOUND', 'That item no longer exists in Google.', { status });
    return new GoogleError('API_ERROR', `Google returned an error (${status}): ${msg}`, { status, reason });
  }

  /**
   * Authenticated call through gapi.client.request. Retries rate limits and server errors with
   * exponential backoff (1s, 2s, 4s). Expired tokens surface as TOKEN_EXPIRED for a Re-authenticate prompt.
   */
  async function request({ path, method = 'GET', params, headers, body, raw = false }) {
    await load();
    if (!state.token) throw new GoogleError('NOT_CONNECTED', 'Connect your Google account in Settings first.');
    if (!tokenValid(state.token)) { setStatus('expired'); throw new GoogleError('TOKEN_EXPIRED', 'Your Google session expired. Re-authenticate to continue.'); }
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await global.gapi.client.request({ path: 'https://www.googleapis.com' + path, method, params, headers, body });
        return raw ? res.body : res.result;
      } catch (err) {
        const e = normalizeError(err);
        const retryable = e.code === 'RATE_LIMIT' || (e.code === 'API_ERROR' && e.status >= 500) || e.code === 'NETWORK';
        if (retryable && attempt < 3 && navigator.onLine !== false) { await sleep(1000 * 2 ** attempt + Math.random() * 300); continue; }
        if (e.code === 'TOKEN_EXPIRED') { setStatus('expired', e); }
        throw e;
      }
    }
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }

  /* ============================================================== GMAIL */
  const b64urlToBytes = (s) => { const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
  const b64urlToText = (s) => { try { return new TextDecoder('utf-8').decode(b64urlToBytes(s)); } catch (_) { return ''; } };
  const htmlToText = (html) => String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#36;/g, '$').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

  /** Flattens a Gmail message payload into { text, attachments[] }. */
  function readPayload(payload) {
    let plain = '', html = ''; const attachments = [];
    (function walk(p) {
      if (!p) return;
      const mime = (p.mimeType || '').toLowerCase();
      if (p.filename && p.body && (p.body.attachmentId || p.body.data)) {
        attachments.push({ filename: p.filename, mimeType: mime, size: p.body.size || 0, attachmentId: p.body.attachmentId, data: p.body.data });
      } else if (mime === 'text/plain' && p.body && p.body.data) plain += b64urlToText(p.body.data) + '\n';
      else if (mime === 'text/html' && p.body && p.body.data) html += b64urlToText(p.body.data) + '\n';
      (p.parts || []).forEach(walk);
    })(payload);
    return { text: (plain || htmlToText(html)).slice(0, 20000), attachments };
  }

  const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  const DATE_RX = `(\\d{1,2}[\\/\\-]\\d{1,2}(?:[\\/\\-]\\d{2,4})?|${MON}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}\\s+${MON}(?:\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2})`;
  const MONEY_RX = '\\$\\s?(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|\\d+(?:\\.\\d{2})?)';
  // Most specific first. The card minimum payment is captured separately (minimumDue).
  const AMOUNT_LABELS = ['total amount due', 'amount due', 'total due', 'balance due', 'statement balance', 'new balance', 'current balance', 'amount owed', 'you owe', 'bill amount', 'invoice total', 'total charges', 'payment amount', 'minimum payment due', 'minimum payment', 'total'];
  const PAID_RX = /\b(payment (?:received|confirmation|posted|processed|successful|scheduled)|thank you for your payment|we received your payment|receipt for your payment|your payment of|has been paid|paid in full|autopay (?:payment )?(?:processed|scheduled|confirmation))\b/i;
  const CARD_RX = /\b(credit card|card ending|minimum payment|statement balance|new balance|card member|cardmember)\b/i;

  function parseMoney(s) { const n = parseFloat(String(s).replace(/[,$\s]/g, '')); return isFinite(n) ? Math.round(n * 100) / 100 : null; }

  function parseDueDate(raw, ref) {
    const clean = String(raw).replace(/(\d)(st|nd|rd|th)\b/i, '$1');
    if (global.StatementParser && global.StatementParser.parseDateToken) {
      // Future dates are expected here, so infer a missing year from the email date, rolling forward.
      let iso = global.StatementParser.parseDateToken(clean, { order: 'MDY', ref: new Date(ref.getFullYear(), 11, 31) });
      if (iso && !/\d{4}/.test(clean)) { const d = new Date(iso); if (d < new Date(ref.getTime() - 15 * 864e5)) iso = (d.getFullYear() + 1) + iso.slice(4); }
      return iso;
    }
    const d = new Date(clean + (/\d{4}/.test(clean) ? '' : ' ' + ref.getFullYear()));
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }

  function senderName(from) {
    const m = String(from || '').match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>/);
    const name = m ? m[1].trim() : '';
    const email = m ? m[2] : String(from || '').trim();
    const domain = (email.split('@')[1] || '').replace(/^(mail|email|e|info|alerts?|billing|notify|notifications?|no-?reply|service)\./i, '');
    const fromDomain = domain.split('.').slice(-2, -1)[0] || '';
    const cleaned = name.replace(/\b(billing|alerts?|notifications?|no-?reply|customer service|statements?|team)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
    return cleaned || (fromDomain ? fromDomain.charAt(0).toUpperCase() + fromDomain.slice(1) : 'Unknown sender');
  }

  /**
   * Deterministic bill / statement detection for one email.
   * Input: { id, subject, from, date (ISO or ms), snippet, text, attachments }
   * Output: { kind: 'bill'|'card-statement'|'paid'|'statement'|'other', merchant, amount, dueDate, pending, confidence, evidence, attachments }
   */
  function analyzeEmail(msg, today = new Date()) {
    const subject = msg.subject || '', snippet = msg.snippet || '', text = msg.text || '';
    const hay = `${subject}\n${snippet}\n${text}`.replace(/\s+/g, ' ');
    const sent = msg.date ? new Date(msg.date) : today;
    const merchant = senderName(msg.from);

    // Amount: the first money value that follows a known label, preferring the most specific label.
    let amount = null, amountLabel = null;
    for (const label of AMOUNT_LABELS) {
      const m = hay.match(new RegExp(label.replace(/ /g, '\\s+') + '[^$\\d]{0,40}' + MONEY_RX, 'i'));
      if (m) { amount = parseMoney(m[1]); amountLabel = label; break; }
    }
    if (amount == null) { const m = (subject + ' ' + snippet).match(new RegExp(MONEY_RX)); if (m) { amount = parseMoney(m[1]); amountLabel = 'first amount'; } }
    const mm = hay.match(new RegExp('minimum\\s+payment(?:\\s+due)?[^$\\d]{0,30}' + MONEY_RX, 'i'));
    const minimumDue = mm ? parseMoney(mm[1]) : null;

    // Due date: a date that follows "due", "pay by", "payment due date", "due on".
    let dueDate = null;
    const dm = hay.match(new RegExp('(?:payment\\s+due\\s+date|due\\s+date|due\\s+(?:on|by)|pay\\s+by|is\\s+due|due)\\s*[:\\-]?\\s*(?:on\\s+)?' + DATE_RX, 'i'));
    if (dm) dueDate = parseDueDate(dm[1], sent);

    const pdfs = (msg.attachments || []).filter((a) => /pdf|csv|comma-separated/i.test(a.mimeType + ' ' + a.filename));
    const paid = PAID_RX.test(hay);
    const card = CARD_RX.test(hay);
    const statementWord = /\bstatement\b/i.test(subject);
    let kind = 'other';
    if (paid) kind = 'paid';
    else if (card && (amount != null || statementWord)) kind = 'card-statement';
    else if (amount != null && /\b(bill|invoice|due|statement|amount|balance|payment)\b/i.test(hay)) kind = 'bill';
    else if (statementWord) kind = 'statement';

    const todayISO = today.toISOString().slice(0, 10);
    const pending = (kind === 'bill' || kind === 'card-statement') && (!dueDate || dueDate >= todayISO);
    const score = (amount != null ? 2 : 0) + (dueDate ? 2 : 0) + (amountLabel && amountLabel !== 'first amount' ? 1 : 0) + (kind !== 'other' ? 1 : 0);
    return {
      id: msg.id, subject, from: msg.from, sentAt: sent.toISOString(), merchant, kind, amount, amountLabel, minimumDue, dueDate, pending,
      confidence: score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low',
      evidence: (snippet || text).slice(0, 180),
      attachments: pdfs,
    };
  }

  const gmail = {
    DEFAULT_QUERY: 'subject:(statement OR bill OR invoice) newer_than:30d',

    /** Lists matching message ids (users.messages.list), newest first. */
    async list({ query, max = 25 } = {}) {
      const res = await request({ path: '/gmail/v1/users/me/messages', params: { q: query || gmail.DEFAULT_QUERY, maxResults: Math.min(max, 100) } });
      return (res.messages || []).map((m) => m.id);
    },

    /** Fetches one message and returns subject/from/date/snippet/body text/attachments. */
    async get(id) {
      const m = await request({ path: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, params: { format: 'full' } });
      const h = Object.fromEntries((m.payload && m.payload.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
      const { text, attachments } = readPayload(m.payload);
      return { id: m.id, threadId: m.threadId, subject: h.subject || '', from: h.from || '', date: Number(m.internalDate) || h.date, snippet: m.snippet || '', text, attachments };
    },

    /** Downloads an attachment as a File, ready for StatementParser / the Upload screen. */
    async attachment(messageId, att) {
      const data = att.data || (await request({ path: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(att.attachmentId)}` })).data;
      return new File([b64urlToBytes(data)], att.filename || 'statement', { type: att.mimeType || 'application/octet-stream' });
    },

    /**
     * Scans recent financial emails and returns detected items, newest first.
     * days: 30 | 60 | 90. Only bills, card statements and statements with attachments are returned.
     */
    async scanBills({ days = 30, max = 25, onProgress } = {}) {
      if (state.token && !hasScope(state.token, SCOPES.gmail)) throw new GoogleError('MISSING_SCOPE', 'Gmail access wasn\'t granted. Re-authenticate and tick the Gmail permission.');
      const query = `subject:(statement OR bill OR invoice OR "payment due" OR "amount due") newer_than:${days}d -in:spam -in:trash`;
      const ids = await gmail.list({ query, max });
      let done = 0;
      const msgs = await mapLimit(ids, 4, async (id) => { const m = await gmail.get(id); onProgress && onProgress(++done, ids.length); return m; });
      const results = msgs.map((m) => analyzeEmail(m)).filter((r) => r.kind !== 'other' || r.attachments.length);
      // Same bill reminded twice: keep the newest per merchant + amount + due date.
      const seen = new Set();
      return results.sort((a, b) => b.sentAt.localeCompare(a.sentAt)).filter((r) => { const k = `${r.merchant}|${r.amount}|${r.dueDate}`; if (seen.has(k)) return false; seen.add(k); return true; });
    },
  };

  /* ============================================================== DRIVE */
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const reportName = (month, format) => { const [y, m] = month.split('-').map(Number); return `Financial_Report_${MONTH_NAMES[m - 1]}_${y}.${format === 'csv' ? 'csv' : 'md'}`; };
  const MIME = { md: 'text/markdown', csv: 'text/csv' };
  let folderId = null;

  function multipartBody(metadata, content, mimeType) {
    const boundary = 'cw' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
    return { body, contentType: `multipart/related; boundary=${boundary}` };
  }
  const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const drive = {
    reportName,

    /** Finds or creates the "Centric Wealth Reports" folder (drive.file only sees what this app created). */
    async folder() {
      if (folderId) return folderId;
      const found = await request({ path: '/drive/v3/files', params: { q: `mimeType='application/vnd.google-apps.folder' and name='${q(REPORT_FOLDER)}' and trashed=false and appProperties has { key='${APP_TAG}' and value='folder' }`, fields: 'files(id)', spaces: 'drive', pageSize: 1 } });
      if (found.files && found.files[0]) return (folderId = found.files[0].id);
      const created = await request({ path: '/drive/v3/files', method: 'POST', params: { fields: 'id' }, body: { name: REPORT_FOLDER, mimeType: 'application/vnd.google-apps.folder', appProperties: { [APP_TAG]: 'folder' } } });
      return (folderId = created.id);
    },

    /**
     * Saves a report with a multipart upload (upload/drive/v3/files?uploadType=multipart).
     * If a report for that month and format already exists it is updated in place (no duplicates).
     */
    async saveReport({ month, format = 'md', content }) {
      if (state.token && !hasScope(state.token, SCOPES.drive)) throw new GoogleError('MISSING_SCOPE', 'Drive access wasn\'t granted. Re-authenticate and tick the Drive permission.');
      const name = reportName(month, format), mimeType = MIME[format] || 'text/plain';
      const parent = await drive.folder();
      const existing = await request({ path: '/drive/v3/files', params: { q: `name='${q(name)}' and '${parent}' in parents and trashed=false`, fields: 'files(id)', pageSize: 1 } });
      const meta = { name, mimeType, description: `Centric Wealth monthly report for ${month}`, appProperties: { [APP_TAG]: 'report', month, format } };
      const fields = 'id,name,webViewLink,modifiedTime,size,mimeType,appProperties';
      if (existing.files && existing.files[0]) {
        const { body, contentType } = multipartBody({ name, mimeType, description: meta.description, appProperties: meta.appProperties }, content, mimeType);
        const file = await request({ path: `/upload/drive/v3/files/${existing.files[0].id}`, method: 'PATCH', params: { uploadType: 'multipart', fields }, headers: { 'Content-Type': contentType }, body });
        return { ...file, updated: true };
      }
      const { body, contentType } = multipartBody({ ...meta, parents: [parent] }, content, mimeType);
      const file = await request({ path: '/upload/drive/v3/files', method: 'POST', params: { uploadType: 'multipart', fields }, headers: { 'Content-Type': contentType }, body });
      return { ...file, updated: false };
    },

    /** Reports this app saved, newest first. */
    async listReports() {
      const res = await request({ path: '/drive/v3/files', params: { q: `appProperties has { key='${APP_TAG}' and value='report' } and trashed=false`, fields: 'files(id,name,modifiedTime,webViewLink,size,mimeType,appProperties)', orderBy: 'modifiedTime desc', pageSize: 50 } });
      return res.files || [];
    },

    /** Downloads a report's text (alt=media). */
    async readReport(id) { return request({ path: `/drive/v3/files/${encodeURIComponent(id)}`, params: { alt: 'media' }, raw: true }); },
  };

  /* ===================================================== MONTHLY REPORT */
  /**
   * Builds the monthly report from the app's data (pure; no Google calls - also used for "Download").
   * data: { transactions, accounts, debts, bills, settings }  month: 'YYYY-MM'  format: 'md' | 'csv'
   */
  function buildMonthlyReport(data, month, format = 'md', opts = {}) {
    const currency = (data.settings && data.settings.currency) || 'USD';
    const nf = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    const money = (n) => nf.format(Number(n) || 0);
    const num = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
    const [y, m] = month.split('-').map(Number);
    const label = `${MONTH_NAMES[m - 1]} ${y}`;
    const txs = (data.transactions || []).filter((t) => String(t.date).slice(0, 7) === month);
    const acctType = (t) => (t.accountType === 'bank' || t.accountType === 'credit' ? t.accountType : 'other');
    const income = txs.filter((t) => t.type === 'income').reduce((s, t) => s + Math.abs(t.amount), 0);
    const expenses = txs.filter((t) => t.type === 'expense');
    const spent = expenses.reduce((s, t) => s + Math.abs(t.amount), 0);
    const byType = { bank: 0, credit: 0, other: 0 };
    const cats = {};
    expenses.forEach((t) => { const k = acctType(t); byType[k] += Math.abs(t.amount); const c = (cats[t.category || 'Other'] ||= { bank: 0, credit: 0, other: 0, total: 0 }); c[k] += Math.abs(t.amount); c.total += Math.abs(t.amount); });
    const catRows = Object.entries(cats).sort((a, b) => b[1].total - a[1].total);
    const isBank = (a) => a.kind === 'bank' || (!a.kind && ['Checking', 'Savings', 'Cash'].includes(a.type));
    const isCard = (d) => d.kind === 'credit' || d.type === 'Credit Card';
    const banks = (data.accounts || []).filter(isBank), cards = (data.debts || []).filter(isCard);
    const bankTotal = banks.reduce((s, a) => s + (Number(a.balance) || 0), 0), cardTotal = cards.reduce((s, d) => s + (Number(d.balance) || 0), 0);
    let subs = [];
    if (global.RecurringScanner) {
      const { items } = global.RecurringScanner.analyze(data.transactions || [], { bills: data.bills || [], decisions: (data.settings || {}).recurringDecisions || {} });
      subs = items.filter((i) => i.kind === 'subscription' && i.active && i.status !== 'cancelled').map((i) => ({ name: i.merchant, cadence: i.cadence, amount: i.lastAmount, monthly: i.monthlyCost }));
    }
    if (!subs.length) subs = (data.bills || []).filter((b) => b.isSubscription && b.active !== false).map((b) => ({ name: b.name, cadence: b.frequency, amount: b.amount, monthly: b.frequency === 'yearly' ? b.amount / 12 : b.amount }));
    const subsTotal = subs.reduce((s, x) => s + x.monthly, 0);
    const generated = opts.generatedAt || new Date();
    const asOf = generated.toISOString().slice(0, 10);
    const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '-');

    if (format === 'csv') {
      const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const rows = [['Section', 'Item', 'Detail', 'Amount']];
      rows.push(['Report', 'Month', label, ''], ['Report', 'Generated', asOf, '']);
      rows.push(['Summary', 'Income', '', num(income)], ['Summary', 'Expenses', '', num(spent)], ['Summary', 'Net cash flow', '', num(income - spent)], ['Summary', 'Savings rate', pct(income - spent, income), '']);
      rows.push(['Spending by account type', 'Credit cards', pct(byType.credit, spent), num(byType.credit)], ['Spending by account type', 'Bank accounts', pct(byType.bank, spent), num(byType.bank)]);
      if (byType.other > 0) rows.push(['Spending by account type', 'Not linked to an account', pct(byType.other, spent), num(byType.other)]);
      banks.forEach((a) => rows.push(['Bank balances', a.name, `as of ${asOf}`, num(a.balance)]));
      rows.push(['Bank balances', 'Total bank balance', '', num(bankTotal)]);
      cards.forEach((d) => rows.push(['Credit card debt', d.name, d.apr ? `${d.apr}% APR` : 'APR not set', num(d.balance)]));
      rows.push(['Credit card debt', 'Total owed', '', num(cardTotal)], ['Net', 'Combined net balance', 'bank minus cards', num(bankTotal - cardTotal)]);
      subs.forEach((s) => rows.push(['Subscriptions', s.name, s.cadence, num(s.monthly)]));
      rows.push(['Subscriptions', 'Total per month', `${subs.length} active`, num(subsTotal)]);
      catRows.forEach(([c, v]) => rows.push(['Category breakdown', c, `cards ${num(v.credit)} / bank ${num(v.bank)}`, num(v.total)]));
      return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
    }

    const L = [];
    L.push(`# Financial Report: ${label}`, '', `_Generated by Centric Wealth on ${asOf} from data stored on this device. Balances are as of the generation date._`, '');
    L.push('## Summary', '', '| | Amount |', '|---|---:|',
      `| Income | ${money(income)} |`, `| Expenses | ${money(spent)} |`, `| Net cash flow | ${money(income - spent)} |`, `| Savings rate | ${pct(income - spent, income)} |`, '');
    L.push('## Balances', '', '| Account | Type | Balance |', '|---|---|---:|');
    banks.forEach((a) => L.push(`| ${a.name} | Bank (${a.type || 'account'}) | ${money(a.balance)} |`));
    cards.forEach((d) => L.push(`| ${d.name} | Credit card${d.apr ? `, ${d.apr}% APR` : ''} | -${money(d.balance)} |`));
    L.push(`| **Total bank balance** | | **${money(bankTotal)}** |`, `| **Total credit card debt** | | **-${money(cardTotal)}** |`, `| **Combined net balance** | | **${money(bankTotal - cardTotal)}** |`, '');
    L.push('## Spending by account type', '', '| Paid with | Amount | Share |', '|---|---:|---:|',
      `| Credit cards | ${money(byType.credit)} | ${pct(byType.credit, spent)} |`, `| Bank accounts | ${money(byType.bank)} | ${pct(byType.bank, spent)} |`);
    if (byType.other > 0) L.push(`| Not linked to an account | ${money(byType.other)} | ${pct(byType.other, spent)} |`);
    L.push('');
    L.push(`## Subscriptions (${subs.length} active, ${money(subsTotal)}/month)`, '');
    if (subs.length) { L.push('| Subscription | Billing | Charge | Per month |', '|---|---|---:|---:|'); subs.forEach((s) => L.push(`| ${s.name} | ${s.cadence} | ${money(s.amount)} | ${money(s.monthly)} |`)); }
    else L.push('No active subscriptions found.');
    L.push('', '## Category breakdown', '');
    if (catRows.length) { L.push('| Category | Total | Credit cards | Bank | Share |', '|---|---:|---:|---:|---:|'); catRows.forEach(([c, v]) => L.push(`| ${c} | ${money(v.total)} | ${money(v.credit)} | ${money(v.bank)} | ${pct(v.total, spent)} |`)); }
    else L.push('No spending recorded this month.');
    L.push('');
    return L.join('\n');
  }

  global.GoogleWorkspace = {
    version: '1.0.0', SCOPES,
    configure, connect, disconnect, load, getStatus, grantedScopes,
    onChange(fn) { events.addEventListener('change', fn); return () => events.removeEventListener('change', fn); },
    request, gmail, drive, analyzeEmail, buildMonthlyReport,
    GoogleError, ERROR_ACTION,
  };
})(typeof window !== 'undefined' ? window : globalThis);
