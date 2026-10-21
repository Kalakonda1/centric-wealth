/*!
 * Centric Wealth - AdvisorEngine
 * Local, rule-based financial health maths. No network, no AI.
 *
 *   const report = await AdvisorEngine.analyzeFromDB({ extra: 100 });
 *   // or, with data already in memory:
 *   const report = AdvisorEngine.analyze({ transactions, bills, debts, accounts, budgets }, { extra: 100 });
 *   // report = { metrics, health, budget503020, debt, recommendations }
 *
 * Educational estimates only - not financial advice.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ helpers */
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const monthKey = (iso) => String(iso).slice(0, 7);
  const addMonths = (key, n) => { const [y, m] = key.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); };
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const sum = (a, f) => a.reduce((s, x) => s + (f ? f(x) : x), 0);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const pct = (n) => Math.round(n * 1000) / 10; // 0.2345 -> 23.5

  /* ----------------------------------------------- category definitions */
  // Fixed = the same (or nearly) every month and hard to change quickly.
  const FIXED = new Set(['Housing', 'Utilities', 'Insurance', 'Debt Payment', 'Subscriptions', 'Education']);
  // 50/30/20: needs are essentials incl. minimum debt payments; wants are discretionary.
  const NEEDS = new Set(['Housing', 'Utilities', 'Groceries', 'Transport', 'Health', 'Insurance', 'Debt Payment', 'Education']);
  const WANTS = new Set(['Dining', 'Dining Out', 'Shopping', 'Entertainment', 'Subscriptions', 'Travel', 'Gifts', 'Other', 'Cash', 'Uncategorized', 'Fees & Interest']);
  const LIQUID = new Set(['Checking', 'Savings', 'Cash']);
  const HIGH_APR = 15; // % - typical credit-card territory

  /* ===================================================== 1. aggregation */
  /**
   * Monthly averages over the most recent complete months that have data (up to `months`),
   * so a half-finished current month doesn't distort the picture. Falls back to month-to-date.
   */
  function aggregate(data, opts) {
    opts = opts || {};
    const today = opts.today || toISO(new Date());
    const monthsWanted = opts.months || 3;
    const txs = (data.transactions || []).filter((t) => t && t.date && isFinite(t.amount) && t.type !== 'transfer');
    const curKey = monthKey(today);

    const monthsWithData = new Set(txs.map((t) => monthKey(t.date)));
    let months = [];
    for (let i = 1; i <= 12 && months.length < monthsWanted; i++) {
      const k = addMonths(curKey, -i);
      if (monthsWithData.has(k)) months.push(k);
    }
    let partial = false;
    if (!months.length && monthsWithData.has(curKey)) { months = [curKey]; partial = true; }
    months.sort();
    const inWindow = txs.filter((t) => months.includes(monthKey(t.date)));
    const n = Math.max(1, months.length);
    const isIncome = (t) => t.type === 'income';
    const isExpense = (t) => t.type === 'expense';
    const cat = (t) => t.category || 'Other';

    const income = sum(inWindow.filter(isIncome), (t) => Math.abs(t.amount)) / n;
    const expenses = inWindow.filter(isExpense);
    const fixed = sum(expenses.filter((t) => FIXED.has(cat(t)) || t.isRecurring), (t) => Math.abs(t.amount)) / n;
    const totalExpense = sum(expenses, (t) => Math.abs(t.amount)) / n;
    const variable = totalExpense - fixed;

    const byCategory = {};
    expenses.forEach((t) => { byCategory[cat(t)] = (byCategory[cat(t)] || 0) + Math.abs(t.amount) / n; });

    // Debts
    const debts = (data.debts || []).filter((d) => Number(d.balance) > 0);
    const debtTotal = sum(debts, (d) => Number(d.balance));
    const minPayments = sum(debts, (d) => Number(d.minPayment) || 0);
    const weightedApr = debtTotal ? sum(debts, (d) => Number(d.balance) * (Number(d.apr) || 0)) / debtTotal : 0;
    const highAprBalance = sum(debts.filter((d) => Number(d.apr) >= HIGH_APR), (d) => Number(d.balance));
    const mortgage = sum(debts.filter((d) => /mortgage/i.test(d.type || '')), (d) => Number(d.balance));
    const monthlyInterest = sum(debts, (d) => Number(d.balance) * (Number(d.apr) || 0) / 1200);

    // Housing cost for DTI: actual housing spend, or rent/mortgage bills if no transactions yet.
    const housingSpend = byCategory.Housing || 0;
    const housingBills = sum((data.bills || []).filter((b) => b.active !== false && b.category === 'Housing'), (b) => (b.frequency === 'yearly' ? b.amount / 12 : b.amount));
    const housing = Math.max(housingSpend, housingBills);
    // Debt payments already inside "Housing" (mortgage) aren't counted twice.
    const debtPaymentsForDti = minPayments + (mortgage ? 0 : housing);

    // Assets
    const accounts = data.accounts || [];
    const assets = sum(accounts, (a) => Number(a.balance) || 0);
    const liquid = sum(accounts.filter((a) => LIQUID.has(a.type)), (a) => Number(a.balance) || 0);
    const essentials = sum(Object.entries(byCategory).filter(([c]) => NEEDS.has(c)), ([, v]) => v);

    // Budgets: this month so far
    const thisMonth = txs.filter((t) => monthKey(t.date) === curKey && isExpense(t));
    const spentNow = {};
    thisMonth.forEach((t) => { spentNow[cat(t)] = (spentNow[cat(t)] || 0) + Math.abs(t.amount); });
    const budgets = (data.budgets || []).map((b) => ({ category: b.category, limit: b.limit, spent: round2(spentNow[b.category] || 0), over: (spentNow[b.category] || 0) > b.limit }));

    return {
      period: { months, partial, label: months.length ? (months.length === 1 ? months[0] : months[0] + ' to ' + months[months.length - 1]) : null },
      hasData: months.length > 0 && income + totalExpense > 0,
      income: round2(income),
      fixedExpenses: round2(fixed),
      variableExpenses: round2(variable),
      totalExpenses: round2(totalExpense),
      leftOver: round2(income - totalExpense),
      savingsRate: income > 0 ? (income - totalExpense) / income : null,
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, round2(v)])),
      debt: {
        count: debts.length, total: round2(debtTotal), totalExMortgage: round2(debtTotal - mortgage),
        minPayments: round2(minPayments), weightedApr: round2(weightedApr), highAprBalance: round2(highAprBalance),
        monthlyInterest: round2(monthlyInterest),
        dti: income > 0 ? debtPaymentsForDti / income : null,
      },
      housing: round2(housing),
      assets: round2(assets), liquidAssets: round2(liquid), netWorth: round2(assets - debtTotal),
      essentials: round2(essentials),
      emergencyMonths: essentials > 0 ? liquid / essentials : liquid > 0 ? Infinity : 0,
      budgets,
    };
  }

  /* ======================================================= 2. scoring */
  const GRADES = [[93, 'A+'], [85, 'A'], [80, 'A-'], [77, 'B+'], [73, 'B'], [70, 'B-'], [67, 'C+'], [63, 'C'], [60, 'C-'], [50, 'D'], [0, 'F']];
  const gradeFor = (score) => GRADES.find(([min]) => score >= min)[1];
  const tierPoints = (value, tiers) => { for (const [ok, pts] of tiers) if (ok(value)) return pts; return 0; };

  /** Rule-based score out of 100 -> letter grade. Each factor explains itself. */
  function score(m) {
    if (!m.hasData || !(m.income > 0)) {
      return { grade: null, score: null, label: 'Not enough data', summary: 'Add or import at least one month with income and spending to get a score.', factors: [] };
    }
    const f = [];
    const sr = m.savingsRate;
    f.push({
      id: 'savings', label: 'Savings rate', max: 25, value: pct(sr) + '%',
      points: tierPoints(sr, [[(v) => v >= 0.2, 25], [(v) => v >= 0.15, 20], [(v) => v >= 0.1, 15], [(v) => v >= 0.05, 9], [(v) => v >= 0, 4]]),
      target: '20% or more',
      tip: sr < 0 ? 'You are spending more than you earn. Start with the largest variable category.'
        : sr < 0.2 ? 'Aim to save 20% of income. Raising it by 1 point a month gets there without a shock.' : 'Strong savings rate - keep it automatic.',
    });
    const dti = m.debt.dti;
    f.push({
      id: 'dti', label: 'Debt-to-income', max: 20, value: dti == null ? '-' : pct(dti) + '%',
      points: tierPoints(dti, [[(v) => v <= 0.15, 20], [(v) => v <= 0.2, 17], [(v) => v <= 0.28, 13], [(v) => v <= 0.36, 9], [(v) => v <= 0.43, 5]]),
      target: '36% or less (housing + minimum debt payments)',
      tip: dti > 0.36 ? 'Housing and debt take ' + pct(dti) + '% of income. Avoid new debt and put extra payments on the highest APR.'
        : dti > 0.2 ? 'Within the 36% guideline, but housing and minimum debt payments still take ' + pct(dti) + '% of income. Each debt you clear lowers it.'
        : 'Debt payments are at a comfortable level.',
    });
    const em = m.emergencyMonths;
    f.push({
      id: 'emergency', label: 'Emergency fund', max: 20, value: em === Infinity ? 'covered' : (Math.round(em * 10) / 10) + ' months',
      points: tierPoints(em, [[(v) => v >= 6, 20], [(v) => v >= 3, 15], [(v) => v >= 1, 8], [(v) => v > 0, 2]]),
      target: '3-6 months of essential spending in cash',
      tip: em < 3 ? 'Build cash savings toward 3 months of essentials before investing extra.' : 'Emergency cushion is in good shape.',
    });
    const hiMonths = m.income > 0 ? m.debt.highAprBalance / m.income : 0;
    f.push({
      id: 'highApr', label: 'High-interest debt', max: 15, value: m.debt.highAprBalance > 0 ? round2(m.debt.highAprBalance) : 'none',
      points: tierPoints(hiMonths, [[(v) => v === 0, 15], [(v) => v <= 1, 10], [(v) => v <= 3, 5]]),
      target: 'No balances above ' + HIGH_APR + '% APR',
      tip: m.debt.highAprBalance > 0 ? 'You owe ' + round2(m.debt.highAprBalance).toFixed(2) + ' above ' + HIGH_APR + '% APR - the costliest money you have. Put extra payments here first (avalanche).' : 'No high-interest debt.',
    });
    const needsShare = m.income > 0 ? m.essentials / m.income : 1;
    f.push({
      id: 'needs', label: 'Essentials share', max: 10, value: pct(needsShare) + '%',
      points: tierPoints(needsShare, [[(v) => v <= 0.5, 10], [(v) => v <= 0.6, 7], [(v) => v <= 0.7, 4]]),
      target: '50% of income or less',
      tip: needsShare > 0.5 ? 'Essentials are above 50% of income. Housing, transport and insurance are usually the biggest levers.' : 'Essentials fit within 50% of income.',
    });
    const b = m.budgets;
    const within = b.length ? b.filter((x) => !x.over).length / b.length : null;
    f.push({
      id: 'budgets', label: 'Budgets on track', max: 10, value: b.length ? b.filter((x) => !x.over).length + ' of ' + b.length : 'none set',
      points: within == null ? 5 : Math.round(within * 10),
      target: 'All category budgets within limit this month',
      tip: within == null ? 'Set a few category budgets so you can track them.' : within < 1 ? 'Some budgets are over this month: ' + b.filter((x) => x.over).map((x) => x.category).join(', ') + '.' : 'Every budget is on track this month.',
    });

    f.forEach((x) => { x.ratio = x.points / x.max; x.status = x.ratio >= 0.8 ? 'good' : x.ratio >= 0.45 ? 'ok' : 'bad'; });
    let total = sum(f, (x) => x.points);
    // Hard caps: some situations outweigh everything else.
    const caps = [];
    if (sr < 0) { total = Math.min(total, 66); caps.push('Spending exceeds income, so the grade is capped at C.'); }
    if (dti != null && dti > 0.5) { total = Math.min(total, 59); caps.push('Debt-to-income above 50% caps the grade at D.'); }
    const grade = gradeFor(total);
    const summary = grade.startsWith('A') ? 'Excellent - your finances are in great shape.'
      : grade.startsWith('B') ? 'Good foundation with a couple of areas to tighten.'
      : grade.startsWith('C') ? 'Fair - a few changes would make a big difference.'
      : 'Needs attention - focus on the top recommendation first.';
    return { grade, score: total, label: grade, summary, caps, factors: f };
  }

  /* ================================================= 3. 50/30/20 budget */
  function budget503020(m) {
    const income = m.income || 0;
    const cats = m.byCategory || {};
    let needs = sum(Object.entries(cats).filter(([c]) => NEEDS.has(c)), ([, v]) => v);
    let wants = sum(Object.entries(cats).filter(([c]) => !NEEDS.has(c)), ([, v]) => v);
    // Debt payments above the required minimums count toward savings, not needs.
    const debtPaid = cats['Debt Payment'] || 0;
    const extraDebt = Math.max(0, debtPaid - (m.debt ? m.debt.minPayments : 0));
    needs -= extraDebt;
    const savings = income - needs - wants; // what's left (saved, invested or extra debt paydown)
    const row = (key, label, share, actual, desc, cats) => ({
      key, label, targetShare: share, target: round2(income * share), actual: round2(actual),
      actualShare: income > 0 ? actual / income : 0, difference: round2(income * share - actual), description: desc, categories: cats,
    });
    const rows = [
      row('needs', 'Needs', 0.5, needs, 'Housing, utilities, groceries, transport, insurance, minimum debt payments', [...NEEDS]),
      row('wants', 'Wants', 0.3, wants, 'Dining, shopping, entertainment, subscriptions, travel', [...WANTS]),
      row('savings', 'Savings & debt paydown', 0.2, savings, 'Money left over, investing, and debt payments above the minimum', []),
    ];
    // One concrete suggestion, deterministic.
    let suggestion = null;
    const [n, w, s] = rows;
    if (income <= 0) suggestion = null;
    else if (s.actual < s.target) {
      const gap = s.target - s.actual; // includes any overspending when actual savings are negative
      const from = w.actual > w.target ? 'Wants' : n.actual > n.target ? 'Needs' : 'Wants';
      suggestion = 'Shift ' + round2(gap).toFixed(2) + ' a month from ' + from + ' to savings to reach 20%.';
    } else suggestion = 'You are meeting the 20% savings target.';
    const topWants = Object.entries(cats).filter(([c]) => !NEEDS.has(c)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, v]) => ({ category: c, amount: round2(v) }));
    return { income: round2(income), rows, suggestion, topWants };
  }

  /* ============================================ 4. debt payoff calculator */
  /**
   * Month-by-month simulation. Each month: interest accrues (APR/12), every debt gets its minimum,
   * then `extra` plus minimums freed by paid-off debts ("rollover") go to the priority debt.
   *   avalanche: highest APR first (mathematically lowest total interest)
   *   snowball:  smallest balance first (fastest first win)
   */
  function payoff(debts, extra, strategy) {
    extra = Math.max(0, Number(extra) || 0);
    const list = (debts || []).filter((d) => Number(d.balance) > 0).map((d) => ({
      id: d.id, name: d.name, apr: Number(d.apr) || 0, min: Math.max(Number(d.minPayment) || 0, 0),
      start: Number(d.balance), bal: Number(d.balance), interest: 0, paidMonth: null,
    }));
    if (!list.length) return { strategy, months: 0, totalInterest: 0, totalPaid: 0, order: [], feasible: true, monthlyBudget: 0, firstPayoffMonth: 0, timeline: [] };
    // Debts with no minimum entered get 1% of balance + interest, a common card formula.
    list.forEach((d) => { if (!d.min) d.min = round2(d.bal * 0.01 + d.bal * d.apr / 1200); });
    const budget = sum(list, (d) => d.min) + extra;
    const priority = strategy === 'snowball'
      ? (a, b) => a.bal - b.bal || b.apr - a.apr
      : (a, b) => b.apr - a.apr || a.bal - b.bal;
    let month = 0, totalPaid = 0;
    const timeline = [];
    const MAX = 600;
    while (list.some((d) => d.bal > 0.005) && month < MAX) {
      month++;
      for (const d of list) if (d.bal > 0) { const i = d.bal * d.apr / 1200; d.bal += i; d.interest += i; }
      let pool = budget;
      const active = list.filter((d) => d.bal > 0.005);
      for (const d of active) { const p = Math.min(d.min, d.bal, pool); d.bal -= p; pool -= p; totalPaid += p; }
      active.sort(priority);
      for (const d of active) { if (pool <= 0.005) break; const p = Math.min(d.bal, pool); d.bal -= p; pool -= p; totalPaid += p; }
      for (const d of list) if (d.bal <= 0.005 && d.paidMonth == null) { d.bal = 0; d.paidMonth = month; }
      if (month <= 120 && (month % 3 === 0 || month === 1)) timeline.push({ month, balance: round2(sum(list, (d) => d.bal)) });
    }
    const feasible = month < MAX;
    const order = [...list].sort((a, b) => (a.paidMonth ?? 1e9) - (b.paidMonth ?? 1e9)).map((d) => ({
      id: d.id, name: d.name, apr: d.apr, startBalance: round2(d.start), paidOffMonth: d.paidMonth, interest: round2(d.interest),
    }));
    return {
      strategy, feasible, months: feasible ? month : null,
      totalInterest: round2(sum(list, (d) => d.interest)), totalPaid: round2(totalPaid),
      monthlyBudget: round2(budget), firstPayoffMonth: order[0] ? order[0].paidOffMonth : null,
      order, timeline,
    };
  }

  /** Runs both strategies plus minimums-only and says which is optimal and by how much. */
  function compareStrategies(debts, extra) {
    const avalanche = payoff(debts, extra, 'avalanche');
    const snowball = payoff(debts, extra, 'snowball');
    const minimumOnly = payoff(debts, 0, 'avalanche');
    let recommended = 'avalanche', reason = 'Lowest total interest.';
    if (!avalanche.order.length) { recommended = null; reason = 'No debts to pay off.'; }
    else if (!avalanche.feasible && !snowball.feasible) { recommended = null; reason = 'Payments do not cover interest. Increase the monthly amount.'; }
    else if (Math.abs(avalanche.totalInterest - snowball.totalInterest) < 1 && avalanche.months === snowball.months) { reason = 'Both methods cost the same here; snowball and avalanche pick the same order.'; }
    else if (snowball.feasible && (!avalanche.feasible || snowball.totalInterest < avalanche.totalInterest)) { recommended = 'snowball'; reason = 'Lowest total interest for these balances.'; }
    else if (snowball.firstPayoffMonth != null && avalanche.firstPayoffMonth != null && avalanche.totalInterest - snowball.totalInterest > -25 && snowball.firstPayoffMonth < avalanche.firstPayoffMonth) {
      reason = 'Avalanche saves ' + (snowball.totalInterest - avalanche.totalInterest).toFixed(2) + ' in interest; snowball would clear a first debt ' + (avalanche.firstPayoffMonth - snowball.firstPayoffMonth) + ' months sooner if quick wins keep you motivated.';
    } else reason = 'Saves ' + (snowball.totalInterest - avalanche.totalInterest).toFixed(2) + ' in interest versus snowball.';
    return {
      extra: round2(extra), avalanche, snowball, minimumOnly, recommended, reason,
      interestSavedVsMinimum: minimumOnly.feasible && avalanche.feasible ? round2(minimumOnly.totalInterest - Math.min(avalanche.totalInterest, snowball.feasible ? snowball.totalInterest : Infinity)) : null,
      monthsSavedVsMinimum: minimumOnly.feasible && avalanche.feasible ? minimumOnly.months - Math.min(avalanche.months, snowball.months || Infinity) : null,
    };
  }

  /* =================================================== recommendations */
  function recommendations(health, plan, debt) {
    const out = [];
    const weak = (health.factors || []).filter((f) => f.status !== 'good').sort((a, b) => a.ratio - b.ratio || b.max - a.max);
    for (const f of weak.slice(0, 3)) out.push({ id: f.id, title: f.label, text: f.tip, severity: f.status === 'bad' ? 'high' : 'medium' });
    if (plan && plan.suggestion && plan.rows[2].actual < plan.rows[2].target) out.push({ id: 'plan', title: '50/30/20', text: plan.suggestion, severity: 'medium' });
    if (debt && debt.recommended && debt.interestSavedVsMinimum > 0) out.push({ id: 'debt', title: 'Debt plan', text: 'Paying ' + debt.extra.toFixed(2) + ' extra a month with the ' + debt.recommended + ' method saves ' + debt.interestSavedVsMinimum.toFixed(2) + ' in interest and ' + debt.monthsSavedVsMinimum + ' months versus minimums only.', severity: 'low' });
    return out.slice(0, 5);
  }

  /* ============================================================ public */
  function analyze(data, opts) {
    opts = opts || {};
    const metrics = aggregate(data, opts);
    const health = score(metrics);
    const plan = budget503020(metrics);
    const debt = compareStrategies(data.debts || [], opts.extra != null ? opts.extra : 100);
    return { metrics, health, budget503020: plan, debt, recommendations: recommendations(health, plan, debt) };
  }

  async function analyzeFromDB(opts) {
    const DB = global.FinanceDB;
    if (!DB) throw new Error('FinanceDB (index.html) is required for analyzeFromDB');
    const [transactions, bills, debts, accounts, budgets] = await Promise.all(['transactions', 'bills', 'debts', 'accounts', 'budgets'].map((s) => DB.getAll(s)));
    return analyze({ transactions, bills, debts, accounts, budgets }, opts);
  }

  global.AdvisorEngine = {
    version: '1.0.0',
    analyze, analyzeFromDB, aggregate, score, budget503020, payoff, compareStrategies, gradeFor,
    CATEGORIES: { FIXED: [...FIXED], NEEDS: [...NEEDS], WANTS: [...WANTS] },
  };
})(typeof window !== 'undefined' ? window : globalThis);
