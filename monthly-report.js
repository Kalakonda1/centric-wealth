/*!
 * Centric Wealth - MonthlyReport
 * Builds a monthly financial report from the app's local data and saves it as PDF, Markdown or text.
 * Everything runs in the browser. The PDF uses jsPDF + jsPDF-AutoTable from a CDN the first time
 * (then cached offline by sw.js); no server or API is involved.
 *
 *   await MonthlyReport.downloadPdf(data, '2026-10');          // Financial_Report_October_2026.pdf
 *   MonthlyReport.download(data, '2026-10', 'md' | 'txt');     // Markdown / plain text
 *   const text = MonthlyReport.build(data, '2026-10', 'md');
 *
 * data = { transactions, accounts, debts, bills, settings } as loaded from IndexedDB.
 */
(function (global) {
  'use strict';

  const LIBS = {
    jspdf: 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js',
    autotable: 'https://cdn.jsdelivr.net/npm/jspdf-autotable@5.0.9/dist/jspdf.plugin.autotable.min.js',
  };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const BANK_TYPES = ['Checking', 'Savings', 'Cash'];
  const isBank = (a) => a.kind === 'bank' || a.kind === 'cash' || (!a.kind && BANK_TYPES.includes(a.type));
  const isCard = (d) => d.kind === 'credit' || d.type === 'Credit Card';
  const acctType = (t) => (['bank', 'credit', 'cash'].includes(t.accountType) ? t.accountType : 'other');
  const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
  const isLogEntry = (t) => t.source === 'quick-log' || t.accountType === 'cash';
  const isIn = (t) => t.type === 'income' || (t.type === 'transfer' && t.direction === 'in');
  const KIND_LABEL = { 'cash-expense': 'Cash expense', 'cash-income': 'Cash income', sent: 'Money sent', received: 'Money received' };
  const entryKind = (t) => t.entryKind || (t.type === 'expense' ? 'cash-expense' : t.type === 'income' ? 'cash-income' : t.direction === 'out' ? 'sent' : 'received');

  function fileName(month, format = 'md') {
    const [y, m] = month.split('-').map(Number);
    return `Financial_Report_${MONTHS[m - 1]}_${y}.${format === 'txt' ? 'txt' : format === 'pdf' ? 'pdf' : 'md'}`;
  }
  const toISO = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  /* ============================================================ numbers */
  function aggregate(data, month, opts = {}) {
    const all = data.transactions || [];
    const txs = all.filter((t) => String(t.date).slice(0, 7) === month);
    const incomeTx = txs.filter((t) => t.type === 'income');
    const expenseTx = txs.filter((t) => t.type === 'expense');
    const income = sum(incomeTx, (t) => Math.abs(t.amount));
    const expenses = sum(expenseTx, (t) => Math.abs(t.amount));

    const byType = { credit: 0, bank: 0, cash: 0, other: 0 };
    const cats = {};
    expenseTx.forEach((t) => {
      const k = acctType(t), a = Math.abs(t.amount);
      byType[k] += a;
      const c = (cats[t.category || 'Other'] ||= { category: t.category || 'Other', total: 0, credit: 0, bank: 0, cash: 0, other: 0, count: 0 });
      c.total += a; c[k] += a; c.count++;
    });
    const categories = Object.values(cats).sort((a, b) => b.total - a.total);

    const banks = (data.accounts || []).filter(isBank).map((a) => ({ name: a.name, type: a.kind === 'cash' ? 'Cash' : (a.type || 'Bank'), balance: Number(a.balance) || 0, estimated: a.ledger && a.balanceSource === 'estimated' }));
    const cards = (data.debts || []).filter(isCard).map((d) => ({ name: d.name, apr: Number(d.apr) || 0, balance: Number(d.balance) || 0 }));
    const bankTotal = sum(banks, (a) => a.balance), cardTotal = sum(cards, (d) => d.balance);

    // Recurring payments: detected subscriptions and fixed bills (scanner), or the Bills list as a fallback.
    let recurring = [];
    if (global.RecurringScanner) {
      const { items } = global.RecurringScanner.analyze(all, { bills: data.bills || [], decisions: (data.settings || {}).recurringDecisions || {} });
      recurring = items.filter((i) => i.active && i.status !== 'cancelled').map((i) => ({
        name: i.merchant, kind: i.kind, billing: i.cadence, amount: i.lastAmount, monthly: i.monthlyCost, lastDate: i.lastDate, nextDue: i.nextDue,
        status: i.status === 'kept' ? 'Kept' : i.confidence === 'low' ? 'Possible' : 'To review', notes: i.flags.filter((f) => f.code !== 'missing').map((f) => f.message).join('; '),
      }));
    }
    if (!recurring.length) {
      recurring = (data.bills || []).filter((b) => b.active !== false).map((b) => ({
        name: b.name, kind: b.isSubscription ? 'subscription' : 'bill', billing: b.frequency || 'monthly', amount: Number(b.amount) || 0,
        monthly: b.frequency === 'yearly' ? b.amount / 12 : Number(b.amount) || 0, lastDate: b.lastPaid || '', nextDue: '', status: 'Bill', notes: '',
      }));
    }
    recurring.sort((a, b) => (a.kind === 'subscription' ? 0 : 1) - (b.kind === 'subscription' ? 0 : 1) || b.monthly - a.monthly);
    const subscriptions = recurring.filter((r) => r.kind === 'subscription');

    // Cash & transfer log: manual Quick Log entries and anything in the cash wallet.
    const logs = txs.filter(isLogEntry).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const logTotals = { 'cash-expense': 0, 'cash-income': 0, sent: 0, received: 0 };
    const logCounts = { 'cash-expense': 0, 'cash-income': 0, sent: 0, received: 0 };
    logs.forEach((t) => { const k = entryKind(t); logTotals[k] += Math.abs(t.amount); logCounts[k]++; });
    // Money lent / borrowed, all time, per person: what is still outstanding.
    const people = {};
    all.filter((t) => t.counterparty && ['Money Lent', 'Loan Repaid to Me', 'Money Borrowed', 'Loan Repayment'].includes(t.category)).forEach((t) => {
      const key = String(t.counterparty).trim().toLowerCase();
      const p = (people[key] ||= { name: String(t.counterparty).trim(), owedToYou: 0, youOwe: 0 });
      const a = Math.abs(t.amount);
      if (t.category === 'Money Lent') p.owedToYou += a; else if (t.category === 'Loan Repaid to Me') p.owedToYou -= a;
      else if (t.category === 'Money Borrowed') p.youOwe += a; else p.youOwe -= a;
    });
    const loans = Object.values(people).filter((p) => Math.abs(p.owedToYou) > 0.004 || Math.abs(p.youOwe) > 0.004).sort((a, b) => a.name.localeCompare(b.name));

    // Savings funds (Emergency Fund + goals): balances, targets, progress, and this month's deposits.
    const funds = global.Analytics ? global.Analytics.funds(data) : (data.accounts || []).filter((a) => a.kind === 'fund').map((f) => ({ name: f.name, fundType: f.fundType || 'goal', balance: Number(f.balance) || 0, target: Number(f.target) || 0, progress: f.target ? (Number(f.balance) || 0) / f.target : 0, monthsCovered: null }));
    const fundMoves = txs.filter((t) => t.accountType === 'fund');
    const fundsIn = sum(fundMoves.filter((t) => t.direction === 'in'), (t) => Math.abs(t.amount));
    const fundsOut = sum(fundMoves.filter((t) => t.direction === 'out'), (t) => Math.abs(t.amount));

    const [y, m] = month.split('-').map(Number);
    return {
      month, label: `${MONTHS[m - 1]} ${y}`,
      generatedAt: opts.generatedAt || new Date(),
      currency: (data.settings && data.settings.currency) || 'USD',
      income, expenses, net: income - expenses, savingsRate: income > 0 ? (income - expenses) / income : null,
      incomeCount: incomeTx.length, expenseCount: expenseTx.length,
      byType, categories,
      banks, cards, bankTotal, cardTotal, netBalance: bankTotal - cardTotal,
      recurring, subscriptions,
      subscriptionsMonthly: sum(subscriptions, (s) => s.monthly), recurringMonthly: sum(recurring, (s) => s.monthly),
      logs: logs.map((t) => ({ date: String(t.date).slice(0, 10), kind: entryKind(t), kindLabel: KIND_LABEL[entryKind(t)], account: t.accountName || (t.accountType === 'cash' ? 'Cash Wallet' : ''), person: t.counterparty || '', category: t.category || '', description: t.description || '', amount: Math.abs(t.amount), signed: isIn(t) ? Math.abs(t.amount) : -Math.abs(t.amount), counts: t.type !== 'transfer' })),
      logTotals, logCounts, loans,
      funds, fundsTotal: sum(funds, (f) => f.balance), fundsIn, fundsOut,
      netWorth: bankTotal + sum(funds, (f) => f.balance) - cardTotal,
    };
  }

  /* ===================================================== text formats */
  function build(data, month, format = 'md', opts = {}) {
    const r = aggregate(data, month, opts);
    const nf = new Intl.NumberFormat('en-US', { style: 'currency', currency: r.currency });
    const $ = (n) => nf.format(Number(n) || 0);
    const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '-');
    const asOf = toISO(r.generatedAt);
    const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
    return format === 'txt' ? asText(r, $, pct, asOf, cap) : asMarkdown(r, $, pct, asOf, cap);
  }

  function asMarkdown(r, $, pct, asOf, cap) {
    const esc = (s) => String(s).replace(/\|/g, '\\|');
    const L = [];
    const hasCash = r.byType.cash > 0;
    L.push(`# Financial Report: ${r.label}`, '', `_Generated by Centric Wealth on ${asOf} from data stored on this device. Balances are as of that date._`, '');
    L.push('## Summary', '', '| | Amount |', '|---|---:|',
      `| Income (${r.incomeCount} deposit${r.incomeCount === 1 ? '' : 's'}) | ${$(r.income)} |`,
      `| Expenses (${r.expenseCount} transaction${r.expenseCount === 1 ? '' : 's'}) | ${$(r.expenses)} |`,
      `| **Net cash flow** | **${$(r.net)}** |`,
      `| Savings rate | ${r.savingsRate == null ? '-' : Math.round(r.savingsRate * 100) + '%'} |`, '');
    L.push('## Balances', '', '| Account | Type | Balance |', '|---|---|---:|');
    r.banks.forEach((a) => L.push(`| ${esc(a.name)} | ${a.type === 'Cash' ? 'Cash' : `Bank (${esc(a.type)})`} | ${$(a.balance)}${a.estimated ? ' (est.)' : ''} |`));
    r.cards.forEach((d) => L.push(`| ${esc(d.name)} | Credit card${d.apr ? `, ${d.apr}% APR` : ''} | -${$(d.balance)} |`));
    if (!r.banks.length && !r.cards.length) L.push('| No accounts yet | | |');
    L.push(`| **Total bank & cash** | | **${$(r.bankTotal)}** |`, `| **Total credit card debt** | | **-${$(r.cardTotal)}** |`, `| **Net balance** | | **${$(r.netBalance)}** |`, '');
    L.push('## Spending by account type', '', '| Paid with | Amount | Share |', '|---|---:|---:|',
      `| Credit cards | ${$(r.byType.credit)} | ${pct(r.byType.credit, r.expenses)} |`,
      `| Bank accounts | ${$(r.byType.bank)} | ${pct(r.byType.bank, r.expenses)} |`);
    if (hasCash) L.push(`| Cash | ${$(r.byType.cash)} | ${pct(r.byType.cash, r.expenses)} |`);
    if (r.byType.other > 0) L.push(`| Not linked to an account | ${$(r.byType.other)} | ${pct(r.byType.other, r.expenses)} |`);
    L.push('');
    L.push(`## Recurring payments (${r.recurring.length} active, ${$(r.recurringMonthly)}/month)`, '');
    if (r.recurring.length) {
      L.push('| Payment | Type | Billing | Charge | Per month | Notes |', '|---|---|---|---:|---:|---|');
      r.recurring.forEach((s) => L.push(`| ${esc(s.name)} | ${s.kind === 'subscription' ? 'Subscription' : 'Bill'} | ${cap(s.billing)} | ${$(s.amount)} | ${$(s.monthly)} | ${esc([s.status, s.notes].filter(Boolean).join(' - '))} |`));
    } else L.push('No active subscriptions or recurring bills found.');
    L.push('');
    L.push('## Spending by category', '');
    if (r.categories.length) {
      L.push(`| Category | Total | Credit cards | Bank |${hasCash ? ' Cash |' : ''} Share |`, `|---|---:|---:|---:|${hasCash ? '---:|' : ''}---:|`);
      r.categories.forEach((c) => L.push(`| ${esc(c.category)} | ${$(c.total)} | ${$(c.credit)} | ${$(c.bank)} |${hasCash ? ` ${$(c.cash)} |` : ''} ${pct(c.total, r.expenses)} |`));
    } else L.push('No spending recorded this month.');
    L.push('');
    L.push(`## Savings & emergency fund (${$(r.fundsTotal)})`, '');
    if (r.funds.length) {
      L.push('| Fund | Balance | Target | Progress | Note |', '|---|---:|---:|---:|---|');
      r.funds.forEach((f) => L.push(`| ${esc(f.name)}${f.fundType === 'emergency' ? ' (emergency)' : ''} | ${$(f.balance)} | ${f.target ? $(f.target) : '-'} | ${f.target ? Math.round(f.progress * 100) + '%' : '-'} | ${f.monthsCovered != null && f.fundType === 'emergency' ? `covers ${f.monthsCovered.toFixed(1)} months of essentials` : ''} |`));
      L.push('', `This month: ${$(r.fundsIn)} added, ${$(r.fundsOut)} withdrawn. Net worth including funds: **${$(r.netWorth)}**.`, '');
    } else L.push('No savings funds yet.', '');
    L.push('## Cash & transfer log', '');
    L.push('| | Entries | Amount |', '|---|---:|---:|');
    Object.keys(KIND_LABEL).forEach((k) => L.push(`| ${KIND_LABEL[k]} | ${r.logCounts[k]} | ${$(r.logTotals[k])} |`));
    L.push('');
    if (r.logs.length) {
      L.push('| Date | Type | Account | Person / category | Note | Amount |', '|---|---|---|---|---|---:|');
      r.logs.forEach((t) => L.push(`| ${t.date} | ${t.kindLabel} | ${esc(t.account)} | ${esc([t.person, t.category].filter(Boolean).join(' - '))} | ${esc(t.description)} | ${t.signed < 0 ? '-' : '+'}${$(t.amount)} |`));
      L.push('');
    }
    if (r.loans.length) {
      L.push('**Money lent and borrowed (outstanding, all time)**', '', '| Person | They owe you | You owe them |', '|---|---:|---:|');
      r.loans.forEach((p) => L.push(`| ${esc(p.name)} | ${$(Math.max(0, p.owedToYou))} | ${$(Math.max(0, p.youOwe))} |`));
      L.push('');
    }
    return L.join('\n');
  }

  function asText(r, $, pct, asOf, cap) {
    const W = 60;
    const line = (ch = '-') => ch.repeat(W);
    const row = (label, value) => { label = String(label); value = String(value); const dots = Math.max(2, W - label.length - value.length - 2); return `${label} ${'.'.repeat(dots)} ${value}`; };
    const table = (head, rows, widths) => {
      const fmtRow = (cells) => cells.map((c, i) => (i === 0 ? String(c).slice(0, widths[0]).padEnd(widths[0]) : String(c).slice(-widths[i]).padStart(widths[i]))).join('  ').trimEnd();
      return [fmtRow(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmtRow)];
    };
    const L = [];
    L.push(line('='), `FINANCIAL REPORT - ${r.label.toUpperCase()}`, `Generated by Centric Wealth on ${asOf}`, 'From data stored on this device. Balances as of that date.', line('='), '');
    L.push('SUMMARY', line(),
      row(`Income (${r.incomeCount} deposits)`, $(r.income)), row(`Expenses (${r.expenseCount} transactions)`, $(r.expenses)),
      row('Net cash flow', $(r.net)), row('Savings rate', r.savingsRate == null ? '-' : Math.round(r.savingsRate * 100) + '%'), '');
    L.push('BALANCES', line());
    r.banks.forEach((a) => L.push(row(`${a.name} (${a.type})`, $(a.balance))));
    r.cards.forEach((d) => L.push(row(`${d.name} (credit card)`, '-' + $(d.balance))));
    L.push(line(), row('Total bank & cash', $(r.bankTotal)), row('Total credit card debt', '-' + $(r.cardTotal)), row('Net balance', $(r.netBalance)), '');
    L.push('SPENDING BY ACCOUNT TYPE', line(),
      row('Credit cards', `${$(r.byType.credit)}  (${pct(r.byType.credit, r.expenses)})`), row('Bank accounts', `${$(r.byType.bank)}  (${pct(r.byType.bank, r.expenses)})`));
    if (r.byType.cash > 0) L.push(row('Cash', `${$(r.byType.cash)}  (${pct(r.byType.cash, r.expenses)})`));
    if (r.byType.other > 0) L.push(row('Not linked to an account', `${$(r.byType.other)}  (${pct(r.byType.other, r.expenses)})`));
    L.push('');
    L.push(`RECURRING PAYMENTS (${r.recurring.length} active)`, line());
    if (r.recurring.length) {
      L.push(...table(['Payment', 'Billing', 'Per month'], r.recurring.map((s) => [s.name, cap(s.billing), $(s.monthly)]), [30, 12, 14]));
      L.push(row('Total per month', $(r.recurringMonthly)));
    } else L.push('No active subscriptions or recurring bills found.');
    L.push('');
    L.push('SPENDING BY CATEGORY', line());
    if (r.categories.length) L.push(...table(['Category', 'Total', 'Cards', 'Bank', 'Cash'], r.categories.map((c) => [c.category, $(c.total), $(c.credit), $(c.bank), $(c.cash)]), [16, 11, 10, 10, 9]));
    else L.push('No spending recorded this month.');
    L.push('');
    L.push('SAVINGS & EMERGENCY FUND', line());
    if (r.funds.length) {
      r.funds.forEach((f) => L.push(row(`${f.name}${f.target ? ` (${Math.round(f.progress * 100)}% of ${$(f.target)})` : ''}`, $(f.balance))));
      L.push(row('Total savings funds', $(r.fundsTotal)), row('Added this month', $(r.fundsIn)), row('Net worth incl. funds', $(r.netWorth)));
    } else L.push('No savings funds yet.');
    L.push('');
    L.push('CASH & TRANSFER LOG', line());
    Object.keys(KIND_LABEL).forEach((k) => L.push(row(`${KIND_LABEL[k]} (${r.logCounts[k]})`, $(r.logTotals[k]))));
    if (r.logs.length) { L.push(''); L.push(...table(['Date / entry', 'Account', 'Amount'], r.logs.map((t) => [`${t.date.slice(5)} ${t.kindLabel}${t.person ? ' - ' + t.person : ''}`, t.account, `${t.signed < 0 ? '-' : '+'}${$(t.amount)}`]), [34, 12, 12])); }
    if (r.loans.length) { L.push('', 'Outstanding (all time):'); r.loans.forEach((p) => L.push(row(`  ${p.name}`, p.owedToYou > 0 ? `owes you ${$(p.owedToYou)}` : `you owe ${$(p.youOwe)}`))); }
    L.push('');
    return L.join('\n');
  }

  /* ============================================================== saving */
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000); // slow mobile download managers need the URL a while
  }

  /** Markdown / text: generates the file and saves it to the device. Returns { name, size }. */
  function download(data, month, format = 'md') {
    const name = fileName(month, format);
    const blob = new Blob([build(data, month, format)], { type: format === 'txt' ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8' });
    saveBlob(blob, name);
    return { name, size: blob.size };
  }

  /* ================================================================= PDF */
  let libsPromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src.split('/npm/')[1] || src}`));
      document.head.appendChild(s);
    });
  }
  function loadPdfLibs() {
    if (global.jspdf && global.jspdf.jsPDF && (global.autoTable || (global.jspdf.jsPDF.API && global.jspdf.jsPDF.API.autoTable))) return Promise.resolve();
    libsPromise ||= loadScript(LIBS.jspdf).then(() => loadScript(LIBS.autotable)).catch((e) => {
      libsPromise = null;
      throw new Error((navigator.onLine === false ? 'You are offline and the PDF library has not been downloaded yet. Connect once, then PDF reports work offline. ' : '') + e.message);
    });
    return libsPromise;
  }

  const C = {
    ink: [15, 23, 42], muted: [100, 116, 139], line: [226, 232, 240], band: [248, 250, 252],
    brand: [5, 150, 105], sky: [2, 132, 199], violet: [124, 58, 237], amber: [217, 119, 6], rose: [225, 29, 72], slate: [148, 163, 184],
    skyBg: [240, 249, 255], roseBg: [255, 241, 242], brandBg: [236, 253, 245], amberBg: [255, 251, 235], slateBg: [241, 245, 249],
  };
  // Built-in PDF fonts cover Latin-1 only: map typographic characters and drop the rest.
  const pdfText = (s) => String(s == null ? '' : s).replace(/[\u2012-\u2015\u2212]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u2026/g, '...').replace(/[\u00a0\u202f]/g, ' ').replace(/[^\x00-\xFF]/g, '?');

  /** Builds the PDF document (jsPDF instance). */
  async function buildPdf(data, month, opts = {}) {
    await loadPdfLibs();
    const r = aggregate(data, month, opts);
    const { jsPDF } = global.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'letter', compress: true });
    const table = (o) => (global.autoTable ? global.autoTable(doc, o) : doc.autoTable(o));
    const PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight(), M = 14, CW = PW - 2 * M;

    // Money: use the symbol when the PDF font has it ($, EUR sign, pound), otherwise the ISO code.
    const nfSym = new Intl.NumberFormat('en-US', { style: 'currency', currency: r.currency });
    const useCode = /[^\x20-\x7E\u00a0\u00a3\u20ac]/.test(nfSym.format(1));
    const nf = new Intl.NumberFormat('en-US', { style: 'currency', currency: r.currency, currencyDisplay: useCode ? 'code' : 'symbol' });
    const $ = (n) => pdfText(nf.format(Number(n) || 0).replace('\u20ac', 'EUR '));
    const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '-');
    const asOf = toISO(r.generatedAt);
    const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
    const fill = (c) => doc.setFillColor(c[0], c[1], c[2]);
    const color = (c) => doc.setTextColor(c[0], c[1], c[2]);
    const font = (style, size) => { doc.setFont('helvetica', style); doc.setFontSize(size); };
    let y = 0;
    const ensure = (h) => { if (y + h > PH - 18) { doc.addPage(); y = 18; } };
    // `need` = space the first block after the heading needs, so a heading never sits alone at a page end.
    const section = (title, subtitle, need = 22) => {
      ensure(need + 14); y += 6;
      font('bold', 13); color(C.ink); doc.text(pdfText(title), M, y);
      if (subtitle) { font('normal', 8.5); color(C.muted); doc.text(pdfText(subtitle), PW - M, y, { align: 'right' }); }
      y += 2.5; doc.setDrawColor(C.line[0], C.line[1], C.line[2]); doc.setLineWidth(0.3); doc.line(M, y, PW - M, y); y += 5;
    };
    const tableStyle = {
      theme: 'grid', margin: { left: M, right: M, bottom: 18 }, showFoot: 'lastPage', rowPageBreak: 'avoid',
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 2, lineColor: C.line, lineWidth: 0.2, textColor: C.ink, overflow: 'linebreak' },
      headStyles: { fillColor: C.ink, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.band },
    };

    // ---- header band
    fill(C.ink); doc.rect(0, 0, PW, 34, 'F');
    fill(C.brand); doc.rect(0, 34, PW, 1.2, 'F');
    font('normal', 9); color([167, 243, 208]); doc.text('CENTRIC WEALTH', M, 12);
    font('bold', 20); doc.setTextColor(255, 255, 255); doc.text('Financial Report', M, 23);
    font('bold', 13); doc.text(pdfText(r.label), PW - M, 21, { align: 'right' });
    font('normal', 8.5); doc.setTextColor(203, 213, 225); doc.text(`Generated ${asOf} on this device`, PW - M, 27, { align: 'right' });
    y = 44;

    // ---- summary cards (2 rows x 3)
    const cards = [
      { label: 'Total Bank Balances', value: $(r.bankTotal), sub: `${r.banks.length} account${r.banks.length === 1 ? '' : 's'}${r.banks.some((b) => b.type === 'Cash') ? ' incl. cash wallet' : ''}`, accent: C.sky, bg: C.skyBg },
      { label: 'Credit Card Debt', value: $(r.cardTotal), sub: `${r.cards.length} card${r.cards.length === 1 ? '' : 's'}`, accent: C.rose, bg: C.roseBg },
      { label: 'Net Balance', value: $(r.netBalance), sub: r.fundsTotal > 0 ? `+ ${$(r.fundsTotal)} in savings funds` : 'bank & cash minus card debt', accent: r.netBalance >= 0 ? C.brand : C.rose, bg: C.slateBg },
      { label: 'Monthly Income', value: $(r.income), sub: `${r.incomeCount} deposit${r.incomeCount === 1 ? '' : 's'}`, accent: C.brand, bg: C.brandBg },
      { label: 'Monthly Expenses', value: $(r.expenses), sub: `${r.expenseCount} transaction${r.expenseCount === 1 ? '' : 's'}`, accent: C.amber, bg: C.amberBg },
      { label: 'Net Cash Flow', value: $(r.net), sub: r.savingsRate == null ? 'no income recorded' : r.savingsRate < 0 ? 'spending exceeded income' : `saving ${Math.round(r.savingsRate * 100)}% of income`, accent: r.net >= 0 ? C.brand : C.rose, bg: C.slateBg },
    ];
    const gap = 4, cw = (CW - 2 * gap) / 3, ch = 24;
    cards.forEach((c, i) => {
      const x = M + (i % 3) * (cw + gap), yy = y + Math.floor(i / 3) * (ch + gap);
      fill(c.bg); doc.roundedRect(x, yy, cw, ch, 2.5, 2.5, 'F');
      fill(c.accent); doc.rect(x, yy + 3, 1.2, ch - 6, 'F');
      font('normal', 8); color(C.muted); doc.text(pdfText(c.label), x + 5, yy + 7);
      font('bold', 14); color(C.ink); doc.text(c.value, x + 5, yy + 15, { maxWidth: cw - 8 });
      font('normal', 7.5); color(C.muted); doc.text(pdfText(c.sub), x + 5, yy + 20.5, { maxWidth: cw - 8 });
    });
    y += 2 * ch + gap + 2;

    // ---- balances by account
    if (r.banks.length || r.cards.length || r.funds.length) {
      section('Balances by account', `as of ${asOf}`);
      table({ ...tableStyle, startY: y,
        head: [['Account', 'Type', 'Balance']],
        body: [
          ...r.banks.map((a) => [pdfText(a.name), a.type === 'Cash' ? 'Cash wallet' : `Bank (${pdfText(a.type)})`, $(a.balance) + (a.estimated ? ' (est.)' : '')]),
          ...r.cards.map((d) => [pdfText(d.name), `Credit card${d.apr ? ` - ${d.apr}% APR` : ''}`, '-' + $(d.balance)]),
          ...r.funds.map((f) => [pdfText(f.name), f.fundType === 'emergency' ? 'Emergency fund' : 'Savings goal', $(f.balance)]),
        ],
        foot: [['Net balance (bank & cash - cards)', '', $(r.netBalance)], ...(r.funds.length ? [['Net worth incl. savings funds', '', $(r.netWorth)]] : [])],
        footStyles: { fillColor: C.slateBg, textColor: C.ink, fontStyle: 'bold' },
        columnStyles: { 2: { halign: 'right', cellWidth: 40 } },
      });
      y = doc.lastAutoTable.finalY + 4;
    }

    // ---- savings & emergency fund: progress bars
    if (r.funds.length) {
      section('Savings & Emergency Fund', `${$(r.fundsTotal)} saved - ${$(r.fundsIn)} added this month`, Math.min(3, r.funds.length) * 16);
      r.funds.forEach((f) => {
        ensure(15);
        const p = Math.max(0, Math.min(1, f.progress || 0)), col = f.fundType === 'emergency' ? C.brand : C.sky;
        font('bold', 9.5); color(C.ink); doc.text(pdfText(f.name + (f.fundType === 'emergency' ? ' (emergency fund)' : '')), M, y + 3);
        font('normal', 8.5); color(C.muted);
        doc.text(f.target ? `${$(f.balance)} of ${$(f.target)}  (${Math.round((f.progress || 0) * 100)}%)` : $(f.balance), PW - M, y + 3, { align: 'right' });
        fill(C.slateBg); doc.roundedRect(M, y + 5, CW, 3.2, 1.6, 1.6, 'F');
        if (p > 0) { fill(col); doc.roundedRect(M, y + 5, Math.max(3.2, CW * p), 3.2, 1.6, 1.6, 'F'); }
        if (f.fundType === 'emergency' && f.monthsCovered != null) { font('normal', 7.5); color(C.muted); doc.text(`Covers ${f.monthsCovered.toFixed(1)} months of essential spending (${$(f.essentials)}/month).`, M, y + 12); y += 4; }
        y += 12;
      });
    }

    // ---- category breakdown: stacked bar chart + table
    section('Category Breakdown', `${r.categories.length} categories - ${$(r.expenses)} spent`, r.categories.length ? Math.min(10, r.categories.length) * 6.5 + 8 : 10);
    if (!r.categories.length) { font('normal', 9); color(C.muted); doc.text('No spending recorded this month.', M, y + 2); y += 8; }
    else {
      const top = r.categories.slice(0, 10), max = top[0].total, labelW = 38, amtW = 26, barW = CW - labelW - amtW - 4, rowH = 6.5;
      ensure(top.length * rowH + 14);
      const parts = [['credit', C.violet], ['bank', C.sky], ['cash', C.amber], ['other', C.slate]];
      top.forEach((c, i) => {
        const yy = y + i * rowH;
        font('normal', 8.5); color(C.ink); doc.text(pdfText(c.category), M, yy + 3.6, { maxWidth: labelW - 2 });
        fill(C.slateBg); doc.roundedRect(M + labelW, yy + 0.8, barW, 3.8, 1, 1, 'F');
        let x = M + labelW;
        parts.forEach(([k, col]) => { const w = (c[k] / max) * barW; if (w > 0.2) { fill(col); doc.rect(x, yy + 0.8, w, 3.8, 'F'); x += w; } });
        font('bold', 8.5); doc.text($(c.total), PW - M, yy + 3.6, { align: 'right' });
      });
      y += top.length * rowH + 1;
      let lx = M + labelW; font('normal', 7.5);
      parts.filter(([k]) => r.byType[k] > 0).forEach(([k, col]) => {
        fill(col); doc.rect(lx, y, 3, 3, 'F'); color(C.muted);
        const t = `${{ credit: 'Credit cards', bank: 'Bank', cash: 'Cash', other: 'Not linked' }[k]} ${pct(r.byType[k], r.expenses)}`;
        doc.text(t, lx + 4.5, y + 2.6); lx += doc.getTextWidth(t) + 10;
      });
      y += 7;
      const hasCash = r.byType.cash > 0;
      table({ ...tableStyle, startY: y,
        head: [['Category', 'Total', 'Credit cards', 'Bank', ...(hasCash ? ['Cash'] : []), 'Share']],
        body: r.categories.map((c) => [pdfText(c.category), $(c.total), $(c.credit), $(c.bank), ...(hasCash ? [$(c.cash)] : []), pct(c.total, r.expenses)]),
        foot: [['Total', $(r.expenses), $(r.byType.credit), $(r.byType.bank), ...(hasCash ? [$(r.byType.cash)] : []), '100%']],
        footStyles: { fillColor: C.slateBg, textColor: C.ink, fontStyle: 'bold' },
        columnStyles: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [i, { halign: 'right' }])),
      });
      y = doc.lastAutoTable.finalY + 4;
    }

    // ---- flagged subscriptions / recurring payments
    section('Flagged Subscriptions & Recurring Payments', `${r.recurring.length} active - ${$(r.recurringMonthly)}/month`);
    if (!r.recurring.length) { font('normal', 9); color(C.muted); doc.text('No active subscriptions or recurring bills found.', M, y + 2); y += 8; }
    else {
      table({ ...tableStyle, startY: y,
        head: [['Payment', 'Type', 'Billing', 'Last charge', 'Next due', 'Per month', 'Status / notes']],
        body: r.recurring.map((s) => [pdfText(s.name), s.kind === 'subscription' ? 'Subscription' : 'Bill', cap(s.billing), s.lastDate ? `${$(s.amount)} (${s.lastDate.slice(5)})` : $(s.amount), s.nextDue || '-', $(s.monthly), pdfText([s.status, s.notes].filter(Boolean).join(' - '))]),
        foot: [['Total per month', '', '', '', '', $(r.recurringMonthly), '']],
        footStyles: { fillColor: C.slateBg, textColor: C.ink, fontStyle: 'bold' },
        columnStyles: { 3: { halign: 'right' }, 5: { halign: 'right' }, 6: { cellWidth: 46 } },
        didParseCell: (h) => { if (h.section === 'body' && h.column.index === 6 && /price|twice|trial|after you cancelled/i.test(h.cell.raw)) h.cell.styles.textColor = C.rose; },
      });
      y = doc.lastAutoTable.finalY + 4;
    }

    // ---- cash & transfer logs
    section('Cash & Transfer Logs', `${r.logs.length} manual entr${r.logs.length === 1 ? 'y' : 'ies'} this month`, 30);
    ensure(20);
    const tiles = [['Cash spent', 'cash-expense', C.amber], ['Cash received', 'cash-income', C.brand], ['Money sent', 'sent', C.rose], ['Money received', 'received', C.sky]];
    const tw = (CW - 3 * gap) / 4;
    tiles.forEach(([label, k, col], i) => {
      const x = M + i * (tw + gap);
      fill(C.band); doc.roundedRect(x, y, tw, 16, 2, 2, 'F'); fill(col); doc.rect(x, y + 2.5, 1, 11, 'F');
      font('normal', 7.5); color(C.muted); doc.text(label, x + 4, y + 5.5);
      font('bold', 11); color(C.ink); doc.text($(r.logTotals[k]), x + 4, y + 11.5, { maxWidth: tw - 6 });
      font('normal', 7); color(C.muted); doc.text(`${r.logCounts[k]} entr${r.logCounts[k] === 1 ? 'y' : 'ies'}`, x + 4, y + 14.6);
    });
    y += 20;
    if (r.logs.length) {
      table({ ...tableStyle, startY: y,
        head: [['Date', 'Entry', 'Account', 'Person / category', 'Note', 'Amount']],
        body: r.logs.map((t) => [t.date, t.kindLabel + (t.counts ? '' : ' *'), pdfText(t.account), pdfText([t.person, t.category].filter(Boolean).join(' - ')), pdfText(t.description), `${t.signed < 0 ? '-' : '+'}${$(t.amount)}`]),
        columnStyles: { 0: { cellWidth: 20 }, 5: { halign: 'right', cellWidth: 26 } },
        didParseCell: (h) => { if (h.section === 'body' && h.column.index === 5) h.cell.styles.textColor = String(h.cell.raw).startsWith('+') ? C.brand : C.ink; },
      });
      y = doc.lastAutoTable.finalY + 2;
      if (r.logs.some((t) => !t.counts)) { ensure(6); font('italic', 7.5); color(C.muted); doc.text('* Lending, borrowing, repayments and moves between your own accounts change balances but are not counted as income or spending.', M, y + 3, { maxWidth: CW }); y += 7; }
    } else { font('normal', 9); color(C.muted); doc.text('No manual cash or transfer entries this month. Use Quick Log in the app to add them.', M, y + 2); y += 8; }
    if (r.loans.length) {
      table({ ...tableStyle, startY: y + 2,
        head: [['Money lent & borrowed (outstanding, all time)', 'They owe you', 'You owe them']],
        body: r.loans.map((p) => [pdfText(p.name), p.owedToYou > 0 ? $(p.owedToYou) : '-', p.youOwe > 0 ? $(p.youOwe) : '-']),
        columnStyles: { 1: { halign: 'right', cellWidth: 34 }, 2: { halign: 'right', cellWidth: 34 } },
      });
      y = doc.lastAutoTable.finalY + 4;
    }

    // ---- chart summary: the Analytics charts, rendered on this device as images
    if (opts.charts !== false && global.Analytics) {
      try {
        const imgs = await global.Analytics.renderImages(data, month, (n, short) => $(n));
        if (imgs.length) {
          doc.addPage(); y = 18;
          section('Chart Summary', 'from the Analytics dashboard');
          for (const im of imgs) {
            const legend = im.legendRows;
            const w = legend ? 70 : CW, h = (im.height / im.width) * w;
            ensure(h + 14);
            font('bold', 10); color(C.ink); doc.text(pdfText(im.title), M, y + 2);
            doc.addImage(im.dataUrl, 'PNG', M, y + 4, w, h, undefined, 'FAST');
            if (legend) {
              let ly = y + 12;
              legend.forEach((l) => { const c = l.color.match(/\w\w/g).map((x) => parseInt(x, 16)); doc.setFillColor(c[0], c[1], c[2]); doc.rect(M + w + 6, ly - 2.6, 3, 3, 'F'); font('normal', 9); color(C.ink); doc.text(pdfText(l.label), M + w + 11, ly); doc.text(`${Math.round(l.share * 100)}%`, PW - M - 28, ly, { align: 'right' }); font('bold', 9); doc.text(l.value, PW - M, ly, { align: 'right' }); ly += 6.5; });
            } else if (im.caption) { font('normal', 7.5); color(C.muted); doc.text(pdfText(im.caption), M, y + 4 + h + 3.5, { maxWidth: CW }); }
            y += h + 12;
          }
        }
      } catch (e) {
        ensure(10); font('italic', 8); color(C.muted); doc.text(pdfText(`Charts could not be added: ${e.message}`), M, y + 4); y += 8;
      }
    }

    // ---- footer on every page
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setDrawColor(C.line[0], C.line[1], C.line[2]); doc.line(M, PH - 12, PW - M, PH - 12);
      font('normal', 7.5); color(C.muted);
      doc.text(pdfText(`Centric Wealth - ${r.label} - generated ${asOf} from data stored on this device. Not financial advice.`), M, PH - 7.5);
      doc.text(`Page ${i} of ${pages}`, PW - M, PH - 7.5, { align: 'right' });
    }
    doc.setProperties({ title: `Financial Report - ${r.label}`, subject: 'Monthly financial report', creator: 'Centric Wealth' });
    return doc;
  }

  /** Builds the PDF and saves it to the device as Financial_Report_<Month>_<Year>.pdf. */
  async function downloadPdf(data, month, opts = {}) {
    const doc = await buildPdf(data, month, opts);
    const name = fileName(month, 'pdf');
    const blob = doc.output('blob');
    saveBlob(blob, name);
    return { name, size: blob.size, pages: doc.getNumberOfPages() };
  }

  /** Phones that support it (notably iPhone) get the share sheet, e.g. "Save to Files". */
  async function share(data, month, format = 'md') {
    const name = fileName(month, format);
    const blob = format === 'pdf' ? (await buildPdf(data, month)).output('blob') : new Blob([build(data, month, format)]);
    const file = new File([blob], name, { type: format === 'pdf' ? 'application/pdf' : format === 'txt' ? 'text/plain' : 'text/markdown' });
    if (!(navigator.canShare && navigator.canShare({ files: [file] }))) return false;
    try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e && e.name !== 'AbortError') throw e; }
    return true;
  }
  const canShareFiles = () => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] })); } catch (_) { return false; } };

  global.MonthlyReport = { version: '2.0.0', LIBS, build, aggregate, download, buildPdf, downloadPdf, share, canShareFiles, fileName, loadPdfLibs };
})(typeof window !== 'undefined' ? window : globalThis);
