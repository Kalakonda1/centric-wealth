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

  /* ============================================== income vs expenses */
  /** Per month: income, expenses split by where they were paid from, savings rate, money moved into funds. */
  function monthly(data, months) {
    const txs = data.transactions || [];
    return months.map((m) => {
      const inMonth = txs.filter((t) => monthKey(t.date) === m);
      const income = sum(inMonth.filter((t) => t.type === 'income'), (t) => Math.abs(t.amount));
      const exp = { bank: 0, credit: 0, cash: 0, other: 0 };
      inMonth.filter((t) => t.type === 'expense').forEach((t) => { const k = ['bank', 'credit', 'cash'].includes(t.accountType) ? t.accountType : 'other'; exp[k] += Math.abs(t.amount); });
      const expense = exp.bank + exp.credit + exp.cash + exp.other;
      const toFunds = sum(inMonth.filter((t) => t.accountType === 'fund'), (t) => effect(t, 'fund'));
      return { month: m, label: shortMonth(m), income: round2(income), expense: round2(expense), bank: round2(exp.bank + exp.other), credit: round2(exp.credit), cash: round2(exp.cash),
        net: round2(income - expense), savingsRate: income > 0 ? (income - expense) / income : null, toFunds: round2(toFunds), hasData: inMonth.length > 0 };
    });
  }

  /* ======================================================= categories */
  /** Spending by category over the given months; the tail beyond `top` folds into "Other". */
  function categories(data, months, top = 5) {
    const set = new Set(months);
    const by = {};
    (data.transactions || []).filter((t) => t.type === 'expense' && set.has(monthKey(t.date))).forEach((t) => { const c = t.category || 'Other'; by[c] = (by[c] || 0) + Math.abs(t.amount); });
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
    const txs = data.transactions || [];
    const todayISO = toISO(today);
    const cards = (data.debts || []).filter(isCard).map((c) => {
      const own = txs.filter((t) => belongs(t, c, 'credit'));
      const first = own.reduce((min, t) => (!min || t.date < min ? t.date : min), null);
      const charges = months.map((m) => round2(sum(own.filter((t) => t.type === 'expense' && monthKey(t.date) === m), (t) => Math.abs(t.amount))));
      const owed = months.map((m) => {
        const end = monthEnd(m);
        if (end >= todayISO) return round2(c.balance);
        if (!first || monthKey(first) > m) return null; // before this card's history starts
        return round2(Number(c.balance) - sum(own.filter((t) => t.date > end), (t) => effect(t, 'credit')));
      });
      const limit = Number(c.creditLimit) || 0;
      return { id: c.id, name: c.name, apr: Number(c.apr) || 0, balance: round2(c.balance), limit, utilization: limit > 0 ? Math.max(0, Number(c.balance)) / limit : null, charges, owed };
    });
    const totalCharges = months.map((_, i) => round2(sum(cards, (c) => c.charges[i])));
    const totalOwed = months.map((_, i) => (cards.some((c) => c.owed[i] != null) ? round2(sum(cards, (c) => c.owed[i] || 0)) : null));
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
    const accts = (data.accounts || []).filter(isBank);
    const now = sum(accts, (a) => Number(a.balance) || 0);
    const moving = [];
    accts.filter((a) => a.ledger).forEach((a) => { const k = acctKind(a); (data.transactions || []).forEach((t) => { if (belongs(t, a, k)) moving.push({ date: String(t.date).slice(0, 10), eff: effect(t, k) }); }); });
    moving.sort((a, b) => b.date.localeCompare(a.date));
    const points = [];
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let bal = now, i = 0;
    for (let d = 0; d <= days; d++) {
      const day = new Date(end); day.setDate(end.getDate() - d);
      const iso = toISO(day);
      while (i < moving.length && moving[i].date > iso) { bal -= moving[i].eff; i++; }
      if (step === 'day' || d % 7 === 0) points.push({ date: iso, balance: round2(bal) });
    }
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
    if (global.Chart) return Promise.resolve(global.Chart);
    chartPromise ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CHART_URL; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = () => (global.Chart ? resolve(global.Chart) : reject(new Error('Chart.js did not start')));
      s.onerror = () => { chartPromise = null; reject(new Error(navigator.onLine === false ? 'You are offline and the chart library has not been downloaded yet. Connect once, then charts work offline.' : 'Could not load the chart library.')); };
      document.head.appendChild(s);
    });
    return chartPromise;
  }

  /** Validated palette (dataviz reference instance): fixed categorical order, separate status colors. */
  function theme(mode = 'light') {
    const dark = mode === 'dark';
    return {
      mode,
      series: dark ? ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] : ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
      status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
      surface: dark ? '#0f172a' : '#ffffff', ink: dark ? '#f0efec' : '#0b0b0b', ink2: dark ? '#c3c2b7' : '#52514e', muted: '#898781',
      grid: dark ? '#2c2c2a' : '#e1e0d9', axis: dark ? '#383835' : '#c3c2b7', neutral: dark ? '#383835' : '#e2e8f0',
    };
  }

  function baseOptions(t, fmt, extra = {}) {
    return {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 700, easing: 'easeOutCubic' },
      layout: { padding: { top: 4, right: 6 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: t.ink2, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded', padding: 14, font: { size: 11 } } },
        tooltip: { backgroundColor: t.mode === 'dark' ? '#1e293b' : '#0f172a', titleColor: '#fff', bodyColor: '#e2e8f0', padding: 10, cornerRadius: 8, boxPadding: 4, callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y ?? c.parsed)}` } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.muted, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 } },
        y: { grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, font: { size: 11 }, callback: (v) => fmt(v, true), maxTicksLimit: 5 }, beginAtZero: true },
      },
      ...extra,
    };
  }
  const bar = (label, data, color, stack, extra = {}) => ({ label, data, backgroundColor: color, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', borderWidth: 0, stack, maxBarThickness: 26, categoryPercentage: 0.7, barPercentage: 0.9, ...extra });
  const line = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 10, tension: 0.3, spanGaps: true, ...extra });
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
        bar('Cash spent', series.map((m) => m.cash), s[3], 'expense', { borderRadius: { topLeft: 4, topRight: 4 }, ...gapStack(t) }),
      ] }, options: baseOptions(t, fmt, {}) };
    },
    /** Monthly credit charges stacked per card. */
    creditSpending(cc, labels, t, fmt) {
      return { type: 'bar', data: { labels, datasets: cc.cards.slice(0, 6).map((c, i, arr) => bar(c.name, c.charges, t.series[i], 'cards', { borderRadius: i === arr.length - 1 ? { topLeft: 4, topRight: 4 } : 0, ...(i ? gapStack(t) : {}) })) }, options: baseOptions(t, fmt) };
    },
    /** End-of-month amount owed: one line per card plus the total. */
    debtTrajectory(cc, labels, t, fmt) {
      const ds = cc.cards.slice(0, 5).map((c, i) => line(c.name, c.owed, t.series[i]));
      if (cc.cards.length > 1) ds.push(line('Total owed', cc.totalOwed, t.ink2, { borderDash: [], borderWidth: 2.5 }));
      return { type: 'line', data: { labels, datasets: ds }, options: baseOptions(t, fmt) };
    },
    /** Category doughnut (<= 6 segments). */
    categories(cat, t, fmt) {
      const colors = cat.rows.map((r, i) => (r.category === 'Other' && i === cat.rows.length - 1 ? t.muted : t.series[i]));
      return { type: 'doughnut', data: { labels: cat.rows.map((r) => r.category), datasets: [{ data: cat.rows.map((r) => r.total), backgroundColor: colors, borderColor: t.surface, borderWidth: 2, hoverOffset: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '68%', animation: { animateRotate: true, duration: 800 },
          plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0f172a', padding: 10, cornerRadius: 8, callbacks: { label: (c) => `${c.label}: ${fmt(c.parsed)} (${Math.round((c.parsed / cat.total) * 100)}%)` } } } } };
    },
    /** Savings rate per month (single series; negative months drop below zero). */
    savingsRate(series, t) {
      return { type: 'bar', data: { labels: series.map((m) => m.label), datasets: [bar('Savings rate', series.map((m) => (m.savingsRate == null ? null : Math.round(m.savingsRate * 100))), series.map((m) => (m.savingsRate != null && m.savingsRate < 0 ? t.status.critical : t.series[0])), 'rate', { borderRadius: 4, borderSkipped: false })] },
        options: baseOptions(t, (v) => `${v}%`, { plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0f172a', padding: 10, cornerRadius: 8, callbacks: { label: (c) => `Saved ${c.parsed.y}% of income` } } } }) };
    },
    /** Bank + cash balance over time. */
    cashFlow(cf, t, fmt) {
      const labels = cf.points.map((p) => { const d = parseISO(p.date); return `${MON[d.getMonth()]} ${d.getDate()}`; });
      return { type: 'line', data: { labels, datasets: [line('Bank & cash balance', cf.points.map((p) => p.balance), t.series[0], { fill: 'origin', backgroundColor: t.series[0] + '22', tension: 0.25, stepped: false })] },
        options: baseOptions(t, fmt, { plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0f172a', padding: 10, cornerRadius: 8, callbacks: { label: (c) => `Balance: ${fmt(c.parsed.y)}` } } }, scales: { ...baseOptions(t, fmt).scales, x: { ...baseOptions(t, fmt).scales.x, ticks: { ...baseOptions(t, fmt).scales.x.ticks, maxTicksLimit: 6 } }, y: { ...baseOptions(t, fmt).scales.y, beginAtZero: false } } }) };
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
    monthsBack, shortMonth, monthEnd, monthly, categories, creditCards, cashFlow, funds, monthlyEssentials, indicators,
    loadChart, theme, charts, renderImages, effect,
  };
})(typeof window !== 'undefined' ? window : globalThis);
