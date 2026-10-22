/*!
 * Centric Wealth - Analytics
 * Pure calculations for the Analytics dashboard and savings funds, plus Chart.js configurations
 * shared by the app and the PDF report. Chart.js is loaded from a CDN only when charts are shown
 * (and cached offline by sw.js).
 *
 *   const m = Analytics.monthly(data, Analytics.monthsBack(6));     // income / expenses by source
 *   const cc = Analytics.creditCards(data, months);                  // charges, debt trajectory, utilization
 *   const cf = Analytics.cashFlow(data, 90, 'day');                  // bank + cash balance over time
 *   const funds = Analytics.funds(data);                             // savings funds with targets & progress
 *   await Analytics.loadChart();  new Chart(canvas, Analytics.charts.incomeExpense(m, theme));
 */
(function (global) {
  'use strict';

  const CHART_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js';
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const monthKey = (iso) => String(iso).slice(0, 7);
  const addMonths = (key, n) => { const [y, m] = key.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const monthEnd = (key) => { const [y, m] = key.split('-').map(Number); return toISO(new Date(y, m, 0)); };
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const sum = (a, f) => a.reduce((s, x) => s + (Number(f ? f(x) : x) || 0), 0);
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const shortMonth = (key) => { const [y, m] = key.split('-').map(Number); return `${MON[m - 1]} '${String(y).slice(2)}`; };

  /* ----------------------------------------------------------- accounts */
  const BANK_TYPES = ['Checking', 'Savings', 'Cash'];
  const isBank = (a) => a.kind === 'bank' || a.kind === 'cash' || (!a.kind && BANK_TYPES.includes(a.type));
  const isCard = (d) => d.kind === 'credit' || d.type === 'Credit Card';
  const isFund = (a) => a.kind === 'fund';
  const isIn = (t) => t.type === 'income' || (t.type === 'transfer' && t.direction === 'in');
  const acctKind = (a) => (a.kind === 'cash' ? 'cash' : a.kind === 'fund' ? 'fund' : 'bank');
  /** Signed change a transaction makes to an account balance (cards: amount owed). */
  const effect = (t, kind) => (kind === 'credit' ? -1 : 1) * (isIn(t) ? 1 : -1) * Math.abs(Number(t.amount) || 0);
  const belongs = (t, a, kind) => t.accountType === kind && same(t.accountName, a.name);

  function monthsBack(n, today = new Date()) {
    const cur = toISO(today).slice(0, 7);
    return Array.from({ length: n }, (_, i) => addMonths(cur, i - n + 1));
  }

  /* ========================================================== periods */
  // A bucket is a date range { key, label, from, to } (ISO dates, inclusive). Months are the usual bucket.
  const monthBucket = (m) => ({ key: m, label: shortMonth(m), from: m + '-01', to: monthEnd(m) });
  const toBuckets = (list) => list.map((b) => (typeof b === 'string' ? monthBucket(b) : b));
  const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
  const PERIOD_MONTHS = { month: 1, quarter: 3, half: 6, year: 12 };

  /**
   * Calendar period of `type` ('month' | 'quarter' | 'half' | 'year'), `offset` periods from the one containing today
   * (0 = current, -1 = previous...). Quarters start in Jan/Apr/Jul/Oct, halves in Jan/Jul.
   * Returns { type, offset, start, end, label, sub, months, buckets, isCurrent, elapsedDays }.
   * Buckets are weeks of the month (1-7, 8-14, 15-21, 22-end) for a month and months otherwise; buckets that
   * start after today are left out.
   */
  function period(type = 'month', offset = 0, today = new Date()) {
    const len = PERIOD_MONTHS[type] || 1;
    const now = toISO(today), cur = now.slice(0, 7);
    const [y0, m0] = cur.split('-').map(Number);
    const startIdx = Math.floor((m0 - 1) / len) * len;            // first month (0-based) of the current period
    const first = addMonths(`${y0}-${pad(startIdx + 1)}`, offset * len);
    const all = Array.from({ length: len }, (_, i) => addMonths(first, i));
    const start = first + '-01', end = monthEnd(all[len - 1]);
    const [y, m] = first.split('-').map(Number);
    const label = type === 'month' ? `${MON_LONG[m - 1]} ${y}` : type === 'quarter' ? `Q${Math.floor((m - 1) / 3) + 1} ${y}` : type === 'half' ? `H${m <= 6 ? 1 : 2} ${y}` : String(y);
    const sub = type === 'month' || type === 'year' ? '' : `${MON[m - 1]} \u2013 ${MON[(m + len - 2) % 12]}`;
    let buckets;
    if (type === 'month') {
      const last = Number(end.slice(8));
      buckets = [[1, 7], [8, 14], [15, 21], [22, last]].map(([a, b]) => ({ key: `${first}-w${a}`, label: `${a}\u2013${b}`, long: `${MON[m - 1]} ${a}\u2013${b}`, from: `${first}-${pad(a)}`, to: `${first}-${pad(b)}` }));
    } else buckets = all.map(monthBucket);
    const shown = buckets.filter((b) => b.from <= now);
    const isCurrent = start <= now && now <= end;
    const elapsedDays = isCurrent ? Math.round((parseISO(now) - parseISO(start)) / 864e5) : null;
    return { type, offset, start, end, label, sub, months: all.filter((k) => k <= cur), buckets: shown.length ? shown : buckets.slice(0, 1), isCurrent, elapsedDays };
  }
  /** Offset of the `type` period that contains month `key` (used to keep your place when switching period type). */
  function periodOffsetFor(type, key, today = new Date()) {
    const len = PERIOD_MONTHS[type] || 1;
    const [cy, cm] = toISO(today).slice(0, 7).split('-').map(Number), [y, m] = key.split('-').map(Number);
    const idx = (yy, mm) => yy * 12 + Math.floor((mm - 1) / len) * len;
    return Math.min(0, Math.round((idx(y, m) - idx(cy, cm)) / len));
  }
  /**
   * Totals for the period before `p`, for "vs last period". While `p` is still running, the previous period is cut
   * at the same number of days in, so a half-finished month is not compared with a whole one.
   */
  function previousTotals(data, p, today = new Date()) {
    const prev = period(p.type, p.offset - 1, today);
    const to = p.isCurrent ? [addDays(prev.start, p.elapsedDays), prev.end].sort()[0] : prev.end;
    const [tot] = monthly(data, [{ key: 'prev', label: prev.label, from: prev.start, to }]);
    return { ...tot, label: prev.label, partial: p.isCurrent };
  }

  /* ============================================== income vs expenses */
  /**
   * Per bucket (a month key or a { key, label, from, to } range): income, expenses split by where they were paid
   * from, savings rate, money moved into funds.
   */
  function monthly(data, months) {
    const txs = data.transactions || [];
    return toBuckets(months).map((b) => {
      const inMonth = txs.filter((t) => { const d = String(t.date).slice(0, 10); return d >= b.from && d <= b.to; });
      const income = sum(inMonth.filter((t) => t.type === 'income'), (t) => Math.abs(t.amount));
      const exp = { bank: 0, credit: 0, cash: 0, other: 0 };
      inMonth.filter((t) => t.type === 'expense').forEach((t) => { const k = ['bank', 'credit', 'cash'].includes(t.accountType) ? t.accountType : 'other'; exp[k] += Math.abs(t.amount); });
      const expense = exp.bank + exp.credit + exp.cash + exp.other;
      const toFunds = sum(inMonth.filter((t) => t.accountType === 'fund'), (t) => effect(t, 'fund'));
      return { month: b.key, label: b.label, long: b.long || b.label, from: b.from, to: b.to, income: round2(income), expense: round2(expense), bank: round2(exp.bank + exp.other), credit: round2(exp.credit), cash: round2(exp.cash),
        net: round2(income - expense), savingsRate: income > 0 ? (income - expense) / income : null, toFunds: round2(toFunds), hasData: inMonth.length > 0 };
    });
  }

  /* ======================================================= categories */
  /** Spending by category over the given months; the tail beyond `top` folds into "Other". */
  function categories(data, months, top = 5) {
    const bk = toBuckets(months), from = bk[0].from, to = bk[bk.length - 1].to;
    const by = {};
    (data.transactions || []).filter((t) => { const d = String(t.date).slice(0, 10); return t.type === 'expense' && d >= from && d <= to; }).forEach((t) => { const c = t.category || 'Other'; by[c] = (by[c] || 0) + Math.abs(t.amount); });
    const rows = Object.entries(by).map(([category, total]) => ({ category, total: round2(total) })).sort((a, b) => b.total - a.total);
    const total = sum(rows, (r) => r.total);
    let shown = rows.slice(0, top);
    const rest = rows.slice(top);
    const otherIdx = shown.findIndex((r) => r.category === 'Other');
    if (rest.length) {
      const extra = sum(rest, (r) => r.total);
      if (otherIdx >= 0) shown[otherIdx] = { category: 'Other', total: round2(shown[otherIdx].total + extra), folded: rest.length };
      else shown.push({ category: 'Other', total: round2(extra), folded: rest.length });
    }
    shown = shown.map((r) => ({ ...r, share: total > 0 ? r.total / total : 0 }));
    return { rows: shown, total: round2(total), count: rows.length };
  }

  /* ===================================================== credit cards */
  /** Monthly charges per card, end-of-month amount owed (rebuilt from current balance), utilization. */
  function creditCards(data, months, today = new Date()) {
    const txs = data.transactions || [], bk = toBuckets(months);
    const todayISO = toISO(today);
    const cards = (data.debts || []).filter(isCard).map((c) => {
      const own = txs.filter((t) => belongs(t, c, 'credit'));
      const first = own.reduce((min, t) => (!min || t.date < min ? t.date : min), null);
      const charges = bk.map((b) => round2(sum(own.filter((t) => t.type === 'expense' && t.date >= b.from && String(t.date).slice(0, 10) <= b.to), (t) => Math.abs(t.amount))));
      const owed = bk.map((b) => {
        const end = b.to;
        if (end >= todayISO) return round2(c.balance);
        if (!first || first > end) return null; // before this card's history starts
        return round2(Number(c.balance) - sum(own.filter((t) => t.date > end), (t) => effect(t, 'credit')));
      });
      const limit = Number(c.creditLimit) || 0;
      return { id: c.id, name: c.name, apr: Number(c.apr) || 0, balance: round2(c.balance), limit, utilization: limit > 0 ? Math.max(0, Number(c.balance)) / limit : null, charges, owed };
    });
    const totalCharges = bk.map((_, i) => round2(sum(cards, (c) => c.charges[i])));
    const totalOwed = bk.map((_, i) => (cards.some((c) => c.owed[i] != null) ? round2(sum(cards, (c) => c.owed[i] || 0)) : null));
    const withLimit = cards.filter((c) => c.limit > 0);
    const overall = withLimit.length ? sum(withLimit, (c) => Math.max(0, c.balance)) / sum(withLimit, (c) => c.limit) : null;
    return { cards, totalCharges, totalOwed, overallUtilization: overall, missingLimits: cards.filter((c) => !c.limit).map((c) => c.name) };
  }

  /* ======================================================== cash flow */
  /**
   * Combined balance of bank accounts + cash wallet over the last `days`, rebuilt backwards from today's
   * balances. Accounts tracked from statements/Quick Log move with their transactions; hand-entered
   * balances stay flat. step: 'day' | 'week'.
   */
  function cashFlow(data, days = 90, step = 'day', today = new Date()) {
    const t0 = toISO(today);
    return cashFlowRange(data, addDays(t0, -days), t0, step, today);
  }
  /** Same as cashFlow, for the dates from..to (to is capped at today). Weekly points count back from `to`. */
  function cashFlowRange(data, from, to, step = 'day', today = new Date()) {
    const accts = (data.accounts || []).filter(isBank);
    const now = sum(accts, (a) => Number(a.balance) || 0);
    const moving = [];
    accts.filter((a) => a.ledger).forEach((a) => { const k = acctKind(a); (data.transactions || []).forEach((t) => { if (belongs(t, a, k)) moving.push({ date: String(t.date).slice(0, 10), eff: effect(t, k) }); }); });
    moving.sort((a, b) => b.date.localeCompare(a.date));
    const points = [];
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const last = [to, toISO(end)].sort()[0];
    let bal = now, i = 0, k = 0;
    for (let d = 0; ; d++) {
      const day = new Date(end); day.setDate(end.getDate() - d);
      const iso = toISO(day);
      if (iso < from) break;
      while (i < moving.length && moving[i].date > iso) { bal -= moving[i].eff; i++; }
      if (iso > last) continue;
      if (step === 'day' || k % 7 === 0) points.push({ date: iso, balance: round2(bal) });
      k++;
    }
    if (!points.length) points.push({ date: last, balance: round2(bal) });
    points.reverse();
    const vals = points.map((p) => p.balance);
    return { points, start: vals[0], end: vals[vals.length - 1], min: Math.min(...vals), max: Math.max(...vals), change: round2(vals[vals.length - 1] - vals[0]), accounts: accts.length };
  }

  /* ============================================================ funds */
  /** Average monthly essential spending (Advisor's definition), used for "months of expenses" targets. */
  function monthlyEssentials(data) {
    if (global.AdvisorEngine) {
      const m = global.AdvisorEngine.aggregate(data);
      if (m.essentials > 0) return m.essentials;
      if (m.totalExpenses > 0) return m.totalExpenses;
    }
    const recent = monthly(data, monthsBack(4).slice(0, 3)).filter((x) => x.expense > 0);
    return recent.length ? sum(recent, (x) => x.expense) / recent.length : 0;
  }

  /** Savings funds (Emergency Fund + goals) with targets and progress. */
  function funds(data) {
    const essentials = monthlyEssentials(data);
    const txs = data.transactions || [];
    const month = monthKey(toISO(new Date()));
    return (data.accounts || []).filter(isFund).map((f) => {
      const target = f.targetMode === 'months' ? round2((Number(f.targetMonths) || 3) * essentials) : Number(f.target) || 0;
      const balance = round2(f.balance);
      const own = txs.filter((t) => belongs(t, f, 'fund'));
      const thisMonth = sum(own.filter((t) => monthKey(t.date) === month), (t) => effect(t, 'fund'));
      let perMonthNeeded = null;
      if (f.targetDate && target > balance) {
        const td = parseISO(f.targetDate), now = new Date();
        const monthsLeft = Math.max(1, (td.getFullYear() - now.getFullYear()) * 12 + td.getMonth() - now.getMonth());
        perMonthNeeded = round2((target - balance) / monthsLeft);
      }
      return {
        id: f.id, name: f.name, fundType: f.fundType || 'goal', color: f.color || 0, icon: f.icon || (f.fundType === 'emergency' ? 'ShieldCheck' : 'PiggyBank'),
        balance, target, progress: target > 0 ? Math.max(0, balance) / target : 0,
        targetMode: f.targetMode || 'amount', targetMonths: Number(f.targetMonths) || 3, targetDate: f.targetDate || null,
        monthsCovered: essentials > 0 ? Math.max(0, balance) / essentials : null, essentials: round2(essentials),
        thisMonth: round2(thisMonth), perMonthNeeded, entries: own.length,
      };
    }).sort((a, b) => (a.fundType === 'emergency' ? -1 : 0) - (b.fundType === 'emergency' ? -1 : 0) || b.balance - a.balance);
  }

  /* ========================================================= DTI etc. */
  function indicators(data, months) {
    const series = monthly(data, months);
    const latest = [...series].reverse().find((m) => m.income > 0) || series[series.length - 1];
    let dti = null, debtPayments = 0, housing = 0, avgIncome = 0;
    if (global.AdvisorEngine) {
      const m = global.AdvisorEngine.aggregate(data);
      dti = m.debt.dti; debtPayments = m.debt.minPayments; housing = m.housing; avgIncome = m.income;
    }
    return { latest, dti, debtPayments: round2(debtPayments), housing: round2(housing), avgIncome: round2(avgIncome) };
  }

  /* ======================================================== Chart.js */
  let chartPromise = null;
  function loadChart() {
    if (global.Chart) return Promise.resolve(setupChart(global.Chart));
    chartPromise ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CHART_URL; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = () => (global.Chart ? resolve(setupChart(global.Chart)) : reject(new Error('Chart.js did not start')));
      s.onerror = () => { chartPromise = null; reject(new Error(navigator.onLine === false ? 'You are offline and the chart library has not been downloaded yet. Connect once, then charts work offline.' : 'Could not load the chart library.')); };
      document.head.appendChild(s);
    });
    return chartPromise;
  }

  const reducedMotion = () => { try { return global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
  const still = (chart) => chart.config.options && chart.config.options.animation === false; // PDF images, reduced motion

  // Lines "draw in" from left to right on first render (clip widens with an ease-out curve).
  const revealPlugin = {
    id: 'cwReveal',
    beforeDatasetsDraw(chart) {
      if (chart.config.type !== 'line' || still(chart)) return;
      const st = chart.$cwReveal || (chart.$cwReveal = { start: performance.now() });
      const k = Math.min(1, (performance.now() - st.start) / 1300), e = 1 - Math.pow(1 - k, 3);
      if (k >= 1) return;
      const a = chart.chartArea, g = chart.ctx;
      g.save(); g.beginPath(); g.rect(a.left - 6, 0, (a.right - a.left + 12) * e, chart.height); g.clip(); st.clipped = true;
      if (!st.raf) st.raf = requestAnimationFrame(() => { st.raf = 0; if (chart.ctx) chart.draw(); });
    },
    afterDatasetsDraw(chart) { const st = chart.$cwReveal; if (st && st.clipped) { chart.ctx.restore(); st.clipped = false; } },
  };
  // Soft glow under lines and the tapped data point.
  const glowPlugin = {
    id: 'cwGlow',
    beforeDatasetDraw(chart, args) {
      if (still(chart) || chart.config.type !== 'line') return;
      const ds = chart.data.datasets[args.index], g = chart.ctx; g.save();
      g.shadowColor = (typeof ds.borderColor === 'string' ? ds.borderColor : '#10b981') + '88'; g.shadowBlur = 12; g.shadowOffsetY = 4;
    },
    afterDatasetDraw(chart) { if (!still(chart) && chart.config.type === 'line') chart.ctx.restore(); },
  };
  let chartReady = false;
  function setupChart(Chart) {
    if (chartReady) return Chart; chartReady = true;
    Chart.register(revealPlugin, glowPlugin);
    Chart.defaults.font.family = "Manrope, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    return Chart;
  }

  /** Glass-style tooltip shared by every chart. */
  function tooltip(t, label) {
    return {
      backgroundColor: t.mode === 'dark' ? 'rgba(15, 21, 38, .94)' : 'rgba(12, 18, 34, .90)', borderColor: t.mode === 'dark' ? 'rgba(255, 255, 255, .12)' : 'rgba(255, 255, 255, .18)', borderWidth: 1,
      titleColor: '#fff', bodyColor: '#cbd5e1', titleFont: { weight: '800', size: 12 }, bodyFont: { size: 12, weight: '600' },
      padding: { x: 14, y: 12 }, cornerRadius: 14, caretSize: 7, caretPadding: 8, boxPadding: 6, usePointStyle: true, displayColors: true,
      animation: { duration: 220, easing: 'easeOutCubic' }, callbacks: { label },
    };
  }
  // Entry animation: bars grow up one after another; reduced-motion users get none.
  function entryAnimation(kind) {
    if (reducedMotion()) return false;
    if (kind === 'bar') return { duration: 1000, easing: 'easeOutQuint', delay: (c) => (c.type === 'data' && c.mode === 'default' ? c.dataIndex * 60 + c.datasetIndex * 90 : 0) };
    return { duration: 1100, easing: 'easeOutQuint' };
  }

  /** Validated palette (dataviz reference instance): fixed categorical order, separate status colors. */
  function theme(mode = 'light') {
    const dark = mode === 'dark';
    return {
      mode,
      series: dark ? ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] : ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
      status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
      surface: dark ? '#111b2c' : '#ffffff', ink: dark ? '#f0efec' : '#0b0b0b', ink2: dark ? '#c3c2b7' : '#52514e', muted: '#898781',
      grid: dark ? 'rgba(148,163,184,.12)' : 'rgba(15,23,42,.07)', axis: dark ? 'rgba(148,163,184,.25)' : 'rgba(15,23,42,.18)', neutral: dark ? '#383835' : '#e2e8f0',
    };
  }

  function baseOptions(t, fmt, extra = {}, kind = 'line') {
    return {
      responsive: true, maintainAspectRatio: false,
      animation: entryAnimation(kind),
      layout: { padding: { top: 4, right: 6 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: t.ink2, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded', padding: 14, font: { size: 11 } } },
        tooltip: tooltip(t, (c) => `${c.dataset.label}: ${fmt(c.parsed.y ?? c.parsed)}`),
      },
      scales: {
        x: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.muted, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 } },
        y: { grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, font: { size: 11 }, callback: (v) => fmt(v, true), maxTicksLimit: 5 }, beginAtZero: true },
      },
      ...extra,
    };
  }
  // Bars are filled with a vertical gradient: full colour at the top, softer toward the axis.
  // `color` may be one colour or an array (one per bar). Legends and the PDF get the solid colour.
  const barFill = (color, soft = '8c') => (c) => {
    const col = Array.isArray(color) ? color[c.dataIndex] || color[0] : color;
    const a = c.chart.chartArea; if (!a || c.type !== 'data') return col;
    const g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, col); g.addColorStop(1, col + soft); return g;
  };
  const bar = (label, data, color, stack, extra = {}) => ({ label, data, backgroundColor: barFill(color), hoverBackgroundColor: Array.isArray(color) ? color : color, borderRadius: { topLeft: 7, topRight: 7 }, borderSkipped: 'bottom', borderWidth: 0, stack, maxBarThickness: 26, categoryPercentage: 0.7, barPercentage: 0.9, ...extra });
  const line = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 6, pointHoverBorderWidth: 3, pointHoverBorderColor: '#ffffff', pointHoverBackgroundColor: color, pointHitRadius: 14, tension: 0.38, spanGaps: true, borderCapStyle: 'round', ...extra });
  // Vertical gradient under an area line (fades to transparent at the bottom); legends get the solid colour.
  const areaFill = (color, top = '59') => (c) => {
    const a = c.chart.chartArea; if (!a || c.type !== 'data') return color;
    const g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, color + top); g.addColorStop(0.6, color + '14'); g.addColorStop(1, color + '00'); return g;
  };
  // 2px surface gap between stacked segments (no outlines).
  const gapStack = (t) => ({ borderColor: t.surface, borderWidth: { top: 2 } });

  const charts = {
    /** Income next to total expenses, expenses stacked by bank / credit / cash. */
    incomeExpense(series, t, fmt) {
      const s = t.series;
      return { type: 'bar', data: { labels: series.map((m) => m.label), datasets: [
        bar('Income', series.map((m) => m.income), s[0], 'income'),
        bar('Credit card charges', series.map((m) => m.credit), s[1], 'expense', { borderRadius: 0 }),
        bar('Bank outflows', series.map((m) => m.bank), s[2], 'expense', { borderRadius: 0, ...gapStack(t) }),
        bar('Cash spent', series.map((m) => m.cash), s[3], 'expense', { borderRadius: { topLeft: 6, topRight: 6 }, ...gapStack(t) }),
      ] }, options: baseOptions(t, fmt, {}, 'bar') };
    },
    /** Monthly credit charges stacked per card. */
    creditSpending(cc, labels, t, fmt) {
      return { type: 'bar', data: { labels, datasets: cc.cards.slice(0, 6).map((c, i, arr) => bar(c.name, c.charges, t.series[i], 'cards', { borderRadius: i === arr.length - 1 ? { topLeft: 6, topRight: 6 } : 0, ...(i ? gapStack(t) : {}) })) }, options: baseOptions(t, fmt, {}, 'bar') };
    },
    /** End-of-month amount owed: one line per card plus the total. */
    debtTrajectory(cc, labels, t, fmt) {
      const ds = cc.cards.slice(0, 5).map((c, i) => line(c.name, c.owed, t.series[i], { fill: 'origin', backgroundColor: areaFill(t.series[i], cc.cards.length > 1 ? '26' : '59') }));
      if (cc.cards.length > 1) ds.push(line('Total owed', cc.totalOwed, t.ink2, { borderDash: [], borderWidth: 2.5 }));
      return { type: 'line', data: { labels, datasets: ds }, options: baseOptions(t, fmt) };
    },
    /** Category doughnut (<= 6 segments). */
    categories(cat, t, fmt) {
      const colors = cat.rows.map((r, i) => (r.category === 'Other' && i === cat.rows.length - 1 ? t.muted : t.series[i]));
      return { type: 'doughnut', data: { labels: cat.rows.map((r) => r.category), datasets: [{ data: cat.rows.map((r) => r.total), backgroundColor: colors, borderColor: t.surface, borderWidth: 2, borderRadius: 4, hoverOffset: 8, hoverBorderColor: t.surface }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', layout: { padding: 6 },
          animation: reducedMotion() ? false : { animateRotate: true, animateScale: true, duration: 1100, easing: 'easeOutQuart' },
          plugins: { legend: { display: false }, tooltip: tooltip(t, (c) => ` ${c.label}: ${fmt(c.parsed)} (${Math.round((c.parsed / cat.total) * 100)}%)`) } } };
    },
    /** Savings rate per month (single series; negative months drop below zero). */
    savingsRate(series, t) {
      return { type: 'bar', data: { labels: series.map((m) => m.label), datasets: [bar('Savings rate', series.map((m) => (m.savingsRate == null ? null : Math.round(m.savingsRate * 100))), series.map((m) => (m.savingsRate != null && m.savingsRate < 0 ? t.status.critical : t.series[0])), 'rate', { borderRadius: 6, borderSkipped: false })] },
        options: baseOptions(t, (v) => `${v}%`, { plugins: { legend: { display: false }, tooltip: tooltip(t, (c) => `Saved ${c.parsed.y}% of income`) } }, 'bar') };
    },
    /** Bank + cash balance over time. */
    cashFlow(cf, t, fmt) {
      const labels = cf.points.map((p) => { const d = parseISO(p.date); return `${MON[d.getMonth()]} ${d.getDate()}`; });
      return { type: 'line', data: { labels, datasets: [line('Bank & cash balance', cf.points.map((p) => p.balance), t.series[0], { fill: 'origin', backgroundColor: areaFill(t.series[0]), tension: 0.3, stepped: false })] },
        options: baseOptions(t, fmt, { plugins: { legend: { display: false }, tooltip: tooltip(t, (c) => `Balance: ${fmt(c.parsed.y)}`) }, scales: { ...baseOptions(t, fmt).scales, x: { ...baseOptions(t, fmt).scales.x, ticks: { ...baseOptions(t, fmt).scales.x.ticks, maxTicksLimit: 6 } }, y: { ...baseOptions(t, fmt).scales.y, beginAtZero: false } } }) };
    },
  };

  /**
   * Renders chart images for the PDF report (light theme, no animation, white background).
   * Returns [{ title, caption, dataUrl, width, height }].
   */
  async function renderImages(data, month, fmt) {
    const Chart = await loadChart();
    const t = theme('light');
    const months = Array.from({ length: 6 }, (_, i) => addMonths(month, i - 5));
    const labels = months.map(shortMonth);
    const series = monthly(data, months);
    const cc = creditCards(data, months);
    const cat = categories(data, [month]);
    const cf = cashFlow(data, 90, 'day');
    const jobs = [];
    if (series.some((m) => m.income || m.expense)) jobs.push({ title: 'Income vs. expenses (6 months)', caption: 'Expenses stacked by credit cards, bank outflows and cash.', cfg: charts.incomeExpense(series, t, fmt), w: 1000, h: 440 });
    if (cat.rows.length) jobs.push({ title: `Spending by category - ${shortMonth(month)}`, caption: cat.rows.map((r) => `${r.category} ${Math.round(r.share * 100)}%`).join('  |  '), cfg: charts.categories(cat, t, fmt), w: 520, h: 440, legendRows: cat.rows.map((r, i) => ({ label: r.category, value: fmt(r.total), share: r.share, color: r.category === 'Other' && i === cat.rows.length - 1 ? t.muted : t.series[i] })) });
    if (cc.cards.length && cc.totalOwed.some((v) => v != null)) jobs.push({ title: 'Credit card debt trajectory', caption: 'Amount owed at each month end.', cfg: charts.debtTrajectory(cc, labels, t, fmt), w: 1000, h: 400 });
    if (cf.accounts) jobs.push({ title: 'Bank & cash balance (last 90 days)', caption: `Changed ${fmt(cf.change)} over the period.`, cfg: charts.cashFlow(cf, t, fmt), w: 1000, h: 380 });
    const white = { id: 'white', beforeDraw: (c) => { const g = c.ctx; g.save(); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.restore(); } };
    const out = [];
    for (const j of jobs) {
      const canvas = document.createElement('canvas');
      canvas.width = j.w; canvas.height = j.h; canvas.style.width = j.w + 'px'; canvas.style.height = j.h + 'px';
      const cfg = { ...j.cfg, options: { ...j.cfg.options, responsive: false, animation: false, devicePixelRatio: 2 }, plugins: [white] };
      if (cfg.options.plugins && cfg.options.plugins.legend) cfg.options.plugins.legend.labels = { ...(cfg.options.plugins.legend.labels || {}), font: { size: 14 } };
      const chart = new Chart(canvas.getContext('2d'), cfg);
      out.push({ title: j.title, caption: j.caption, dataUrl: chart.toBase64Image('image/png', 1), width: j.w, height: j.h, legendRows: j.legendRows });
      chart.destroy();
    }
    return out;
  }

  global.Analytics = {
    version: '1.0.0', CHART_URL,
    monthsBack, shortMonth, monthEnd, period, periodOffsetFor, previousTotals, monthly, categories, creditCards, cashFlow, cashFlowRange, funds, monthlyEssentials, indicators,
    loadChart, theme, charts, renderImages, effect,
  };
})(typeof window !== 'undefined' ? window : globalThis);
