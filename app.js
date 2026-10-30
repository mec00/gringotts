import { calculate, defaults } from './model.js';

const $ = id => document.getElementById(id);
const form = $('inputs');
let activeTab = 'mortgage';
let currency = 'GBP';
let result = null;
let currentConfig = null;
let lumpId = 0;
let pendingRender = false;
let chartPlot = { left: 63, width: 639 };

const money = (value, decimals = 0) => new Intl.NumberFormat('en-GB', {
  style: 'currency', currency, maximumFractionDigits: decimals, minimumFractionDigits: decimals,
}).format(value);
const compactMoney = value => new Intl.NumberFormat('en-GB', {
  style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1,
}).format(value);
const symbol = () => ({ GBP: '£', USD: '$', EUR: '€' })[currency];
const duration = months => {
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  return [years ? `${years} year${years === 1 ? '' : 's'}` : '', remainder ? `${remainder} month${remainder === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || '0 months';
};
const shortDuration = months => `${Math.floor(months / 12)}<small>y</small> ${months % 12}<small>m</small>`;
const number = id => $(id).valueAsNumber;
const text = (id, value) => { $(id).textContent = value; };

function readLumps(kind) {
  return [...$(`${kind}-lumps`).querySelectorAll('.lump-row')].map(row => ({
    month: row.querySelector('[data-lump-month]').valueAsNumber,
    amount: row.querySelector('[data-lump-amount]').valueAsNumber,
  }));
}

function readConfig() {
  const matchContributions = $('matchContributions').checked;
  const fullHorizon = $('fullHorizon').checked;
  const termMonths = number('termYears') * 12 + number('termExtraMonths');
  return {
    balance: number('balance'),
    termMonths,
    fixedRate: number('fixedRate'),
    fixedMonths: number('fixedMonths'),
    variableRate: number('variableRate'),
    monthlyExtra: number('monthlyExtra'),
    upfrontExtra: number('upfrontExtra'),
    lumps: readLumps('mortgage'),
    limitPercent: number('limitPercent'),
    limitBasis: $('limitBasis').value,
    limitPeriod: $('limitPeriod').value,
    annualReturn: number('annualReturn'),
    startingBalance: number('startingBalance'),
    matchContributions,
    monthlyInvestment: matchContributions ? defaults.monthlyInvestment : number('monthlyInvestment'),
    upfrontInvestment: matchContributions ? defaults.upfrontInvestment : number('upfrontInvestment'),
    investmentLumps: matchContributions ? [] : readLumps('investment'),
    fullHorizon,
    horizonMonths: fullHorizon ? termMonths : number('horizonMonths'),
  };
}

function syncOptions() {
  const matched = $('matchContributions').checked;
  $('custom-investment').hidden = matched;
  $('linked-contributions').hidden = !matched;
  $('custom-investment').querySelectorAll('input, button').forEach(input => { input.disabled = matched; });
  const fullHorizon = $('fullHorizon').checked;
  $('horizon-field').hidden = fullHorizon;
  $('horizonMonths').disabled = fullHorizon;
}

function validateForm() {
  for (const input of form.querySelectorAll('input[type="number"]')) {
    input.required = true;
    input.removeAttribute('aria-invalid');
  }
  const invalid = [...form.querySelectorAll('input, select')].find(input => !input.disabled && !input.validity.valid);
  if (invalid) {
    invalid.setAttribute('aria-invalid', 'true');
    const label = invalid.getAttribute('aria-label') || invalid.labels?.[0]?.textContent || 'Input';
    throw new RangeError(`${label}: ${invalid.validationMessage}`);
  }
}

function renderStats(config) {
  const { baseline, overpaid, comparison, interestSaved, monthsSaved } = result;
  let comparisonNote = 'Different budgets · no fair winner';
  if (comparison.equalBudgets) {
    comparisonNote = Math.abs(comparison.difference) < 1 ?
      'The strategies are effectively equal' :
      `In favour of ${comparison.difference > 0 ? 'investing' : 'overpaying'}`;
  }
  const stats = activeTab === 'mortgage' ? [
    { label: 'Interest saved', value: money(interestSaved), note: `vs ${money(baseline.totalInterest)} without overpaying`, icon: '↗' },
    { label: 'Time saved', value: shortDuration(monthsSaved), note: 'Closer to a mortgage-free future', icon: '◷' },
    { label: 'Mortgage-free in', value: overpaid.payoffMonth === 0 ? 'Today' : shortDuration(overpaid.payoffMonth), note: `Instead of ${duration(baseline.payoffMonth)}`, icon: '⌂' },
  ] : [
    { label: 'Projected difference', value: money(Math.abs(comparison.difference)), note: comparisonNote, icon: '↗' },
    { label: 'Overpay-first net position', value: money(comparison.overpayNet), note: 'Investments minus mortgage debt', icon: '⌂' },
    { label: 'Invest-instead net position', value: money(comparison.investNet), note: `After ${duration(comparison.horizon)}`, icon: '◷' },
  ];
  $('stats').innerHTML = stats.map((stat, index) => `
    <article class="stat ${index === 0 ? 'featured' : ''}">
      <span class="stat-label">${stat.label}<span class="stat-icon" aria-hidden="true">${stat.icon}</span></span>
      <strong class="stat-value">${stat.value}</strong>
      <span class="stat-note">${stat.note}</span>
    </article>`).join('');
  text('results-title', activeTab === 'mortgage' ? 'Your extra payments, in perspective' : 'Two strategies. The same starting point.');
  text('regular-payment', `${money(baseline.rows[1].payment, 2)} / mo`);
  text('payment-change', config.fixedMonths > 0 && config.fixedMonths < config.termMonths ?
    `${money(baseline.rows[config.fixedMonths + 1].payment, 2)} / mo from month ${config.fixedMonths + 1} at ${config.variableRate}%.` :
    `${config.fixedMonths === 0 ? config.variableRate : config.fixedRate}% interest for the remaining term.`);
  text('allowance-label', config.limitPeriod === 'none' ? 'No limit' : `${config.limitPercent}%`);
  text('linked-monthly', money(config.monthlyExtra));
  text('linked-upfront', money(config.upfrontExtra));
  text('linked-lumps', `${config.lumps.length} · ${money(config.lumps.reduce((sum, lump) => sum + lump.amount, 0))}`);
}

function chartSeries() {
  if (activeTab === 'mortgage') {
    return [
      { name: 'With overpayments', data: result.overpaid.rows.map(row => row.balance), color: '#36714e' },
      { name: 'Without overpayments', data: result.baseline.rows.map(row => row.balance), color: '#a3ad9c' },
    ];
  }
  return [
    { name: 'Overpay first', data: result.comparison.rows.map(row => row.overpayNet), color: '#36714e' },
    { name: 'Invest instead', data: result.comparison.rows.map(row => row.investNet), color: '#a3ad9c' },
  ];
}

function renderChart(config) {
  const series = chartSeries();
  const months = series[0].data.length - 1;
  const width = Math.max(300, Math.min(720, $('chart').clientWidth));
  const height = 292;
  const left = 63;
  const right = 18;
  const top = 27;
  const bottom = 35;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  chartPlot = { left, width: chartWidth };
  const allValues = series.flatMap(item => item.data);
  const low = Math.min(0, ...allValues);
  let high = Math.max(0, ...allValues);
  if (high === low) high = low + 1;
  const x = month => left + month / months * chartWidth;
  const y = value => top + (high - value) / (high - low) * chartHeight;
  const line = data => data.map((value, month) => `${month ? 'L' : 'M'}${x(month).toFixed(2)},${y(value).toFixed(2)}`).join(' ');
  const grid = Array.from({ length: 5 }, (_, i) => {
    const value = low + (high - low) * i / 4;
    return `<line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}" stroke="#e9ede3" stroke-dasharray="3 4"/>
      <text x="${left - 12}" y="${y(value) + 3}" text-anchor="end" class="axis-label">${compactMoney(value)}</text>`;
  }).join('');
  const tickCount = Math.min(6, months + 1);
  const ticks = [...new Set(Array.from({ length: tickCount }, (_, i) => Math.round(i / (tickCount - 1) * months)))];
  const axis = ticks.map(month => `<text x="${x(month)}" y="${height - 10}" text-anchor="middle" class="axis-label">${months >= 24 ? `${+(month / 12).toFixed(1)} yr` : `${month} mo`}</text>`).join('');
  const fixedMarker = activeTab === 'mortgage' && config.fixedMonths > 0 && config.fixedMonths < months ?
    `<line x1="${x(config.fixedMonths)}" x2="${x(config.fixedMonths)}" y1="${top}" y2="${height - bottom}" stroke="#c6d3bc" stroke-dasharray="3 4"/>
     <text x="${Math.min(x(config.fixedMonths) + 5, width - 122)}" y="${top - 10}" class="marker-label">VARIABLE RATE STARTS</text>` : '';
  const area = `${line(series[0].data)} L${x(months)},${y(low)} L${x(0)},${y(low)} Z`;
  $('chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="plot-title plot-desc">
    <title id="plot-title">${activeTab === 'mortgage' ? 'Mortgage balance over time' : 'Net financial position over time'}</title>
    <desc id="plot-desc">${series.map(item => `${item.name}: ${money(item.data[0])} initially, ${money(item.data.at(-1))} at month ${months}.`).join(' ')} Use the month slider for individual values or the tables below.</desc>
    <defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#a8c789" stop-opacity=".23"/><stop offset="100%" stop-color="#dfeccc" stop-opacity=".04"/></linearGradient></defs>
    ${grid}${fixedMarker}<path d="${area}" fill="url(#chart-fill)"/>
    ${[...series].reverse().map((item, index) => `<path d="${line(item.data)}" fill="none" stroke="${item.color}" stroke-width="${index === 0 ? 2 : 2.8}" ${index === 0 ? 'stroke-dasharray="5 5"' : ''} stroke-linecap="round" stroke-linejoin="round"/>`).join('')}
    ${axis}
    <line id="chart-cursor" x1="${left}" x2="${left}" y1="${top}" y2="${height - bottom}" stroke="#9eaf93" stroke-width="1"/>
  </svg>`;
  $('chart-legend').innerHTML = series.map((item, i) => `<span class="legend-item"><span class="legend-line ${i ? 'secondary' : ''}"></span>${item.name}</span>`).join('');
  text('chart-title', activeTab === 'mortgage' ? 'The path to mortgage-free' : 'Where your money could take you');
  text('chart-description', activeTab === 'mortgage' ? 'Small overpayments. A shorter journey.' : 'Net position = investments minus outstanding mortgage.');
  text('chart-unit', activeTab === 'mortgage' ? 'BALANCE' : 'NET POSITION');
  $('chart-month').max = months;
  $('chart-month').value = Math.min(Number($('chart-month').value), months);
  $('chart-footer').innerHTML = activeTab === 'mortgage' ?
    `<span aria-hidden="true">⌁</span><span>${result.monthsSaved > 0 ? `Your plan brings mortgage freedom <strong>${duration(result.monthsSaved)} closer.</strong>` : 'Add an overpayment to explore a shorter mortgage term.'}</span>` :
    `<span aria-hidden="true">⌁</span><span>Same horizon: <strong>${duration(result.comparison.horizon)}</strong>. ${result.comparison.equalBudgets ? 'Matched cash contributions in both strategies.' : 'Different cash contributions — compare with care.'}</span>`;
  renderChartValues();
}

function renderChartValues() {
  if (!result) return;
  const month = Number($('chart-month').value);
  const series = chartSeries();
  text('chart-month-label', month);
  $('chart-month').setAttribute('aria-valuetext', `Month ${month}: ${series.map(item => `${item.name} ${money(item.data[month])}`).join(', ')}`);
  $('chart-values').innerHTML = series.map(item => `<span>${item.name}: <strong>${money(item.data[month])}</strong></span>`).join('');
  const x = chartPlot.left + month / (series[0].data.length - 1) * chartPlot.width;
  $('chart-cursor').setAttribute('x1', x);
  $('chart-cursor').setAttribute('x2', x);
}

function renderAllowance(config) {
  const { breaches, overpaid } = result;
  const firstYear = overpaid.years[0];
  const status = $('allowance-status');
  status.classList.toggle('warning', breaches.length > 0);
  let title;
  let message;
  if (breaches.length) {
    title = `Your plan exceeds the allowance in ${breaches.length} model year${breaches.length === 1 ? '' : 's'}`;
    message = `First breach: year ${breaches[0].year}, by ${money(breaches[0].excess, 2)}. Payments are not capped and repayment charges are not included. Check the schedule and your lender's terms before acting.`;
  } else if (config.limitPeriod === 'none' || (config.limitPeriod === 'fixed' && config.fixedMonths === 0)) {
    title = 'No overpayment limit is applied';
    message = config.limitPeriod === 'none' ? 'You have turned off allowance checks. Your lender may still charge for early repayment.' : 'The fixed period is zero months, so a fixed-period-only limit does not apply.';
  } else {
    title = 'Your plan stays within the annual allowance';
    message = `Year 1: ${money(firstYear.countedExtra)} of ${money(firstYear.allowance)} used (${config.limitPercent}%). ${config.limitPeriod === 'fixed' ? 'Checks cover the fixed-rate period only.' : 'All mortgage years checked.'} Model years start today.`;
  }
  status.innerHTML = `<span class="status-icon" aria-hidden="true">${breaches.length ? '!' : '✓'}</span><div><h3>${title}</h3><p>${message}</p></div>`;
}

function renderDecision(config) {
  const { comparison, breaches, breakEven } = result;
  const difference = Math.abs(comparison.difference);
  let title;
  let description;
  if (!comparison.equalBudgets) {
    title = 'Different budgets, different possibilities';
    description = `These plans use different amounts or contribution timing, so there is no like-for-like winner. Match your contributions to compare the strategies fairly.`;
  } else if (difference < 1) {
    title = 'These plans finish in the same place';
    description = `At ${config.annualReturn}% annual investment growth, the projected net positions are within ${money(1)} after ${duration(comparison.horizon)}. Access to cash and your comfort with risk may matter more.`;
  } else {
    const winner = comparison.difference > 0 ? 'Investing' : 'Overpaying';
    title = `${winner} could put you ${money(difference)} ahead`;
    description = `At ${config.annualReturn}% annual investment growth, ${comparison.difference > 0 ? 'investing the extra money' : 'overpaying and investing freed-up payments'} gives a higher projected net position after ${duration(comparison.horizon)}. This assumes steady returns, which are not guaranteed.`;
  }
  if (breaches.length) description += ' Treat this result as provisional: overpayment charges could change the outcome.';
  text('decision-title', title);
  text('decision-text', description);
  $('compare-button').hidden = activeTab === 'investment';
  $('comparison-detail').hidden = activeTab !== 'investment';
  const horizon = comparison.horizon;
  const rows = [
    ['Extra cash allocated', comparison.overpayBudget, comparison.investBudget],
    ['Investment portfolio', comparison.overpayPortfolio, comparison.investPortfolio],
    ['Mortgage remaining', result.overpaid.rows[horizon].balance, result.baseline.rows[horizon].balance],
    ['Net position', comparison.overpayNet, comparison.investNet],
  ];
  $('comparison-table').innerHTML = rows.map(([label, a, b]) => `<tr><th scope="row">${label}</th><td>${money(a)}</td><td>${money(b)}</td></tr>`).join('');
  let breakEvenText = 'No distinct break-even return in the modelled −99% to 50% range. With no extra cash, the strategies are the same.';
  if (!comparison.equalBudgets) {
    breakEvenText = 'A break-even return requires matched contributions and timing.';
  } else if (breakEven !== null) {
    breakEvenText = `Break-even investment return: approximately ${breakEven.toFixed(2)}% a year after tax and fees. Above this, investing projects ahead; below it, overpaying projects ahead. Assumes matched budgets and excludes repayment charges.`;
  }
  text('break-even', breakEvenText);
}

function renderSchedule() {
  $('schedule-body').innerHTML = result.overpaid.years.map((year, i) => `<tr>
    <th scope="row">${year.year}</th>
    <td>${money(result.baseline.years[i].closing)}</td>
    <td>${money(year.closing)}</td>
    <td>${money(year.interest)}</td>
    <td>${money(year.extra)}</td>
    <td class="${year.excess > 0.005 ? 'exceeded' : ''}">${year.active ? `${money(year.countedExtra)} / ${money(year.allowance)}${year.excess > 0.005 ? ' ⚠' : ''}` : 'Not applicable'}</td>
  </tr>`).join('');
}

function render() {
  syncOptions();
  try {
    validateForm();
    currentConfig = readConfig();
    result = calculate(currentConfig);
  } catch (error) {
    if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
    text('form-error', `Results paused — ${error.message} Check the inputs in either calculator tab.`);
    $('form-error').hidden = false;
    $('results').classList.add('stale');
    $('results').inert = true;
    $('results').setAttribute('aria-hidden', 'true');
    $('download').disabled = true;
    return;
  }
  $('form-error').hidden = true;
  $('results').classList.remove('stale');
  $('results').inert = false;
  $('results').removeAttribute('aria-hidden');
  $('download').disabled = false;
  document.querySelectorAll('[data-currency]').forEach(element => { element.textContent = symbol(); });
  renderStats(currentConfig);
  renderChart(currentConfig);
  renderAllowance(currentConfig);
  renderDecision(currentConfig);
  renderSchedule();
}

function switchTab(tab, focus = false) {
  activeTab = tab;
  $('results').dataset.view = tab;
  for (const button of document.querySelectorAll('[data-tab]')) {
    const selected = button.dataset.tab === tab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', selected);
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  $('workspace').setAttribute('aria-labelledby', `${tab}-tab`);
  $('mortgage-inputs').hidden = tab !== 'mortgage';
  $('investment-inputs').hidden = tab !== 'investment';
  render();
}

function addLump(kind) {
  const id = ++lumpId;
  const row = document.createElement('div');
  const label = kind === 'mortgage' ? 'Overpayment' : 'Investment';
  const term = number('termYears') * 12 + number('termExtraMonths');
  const month = Number.isFinite(term) ? Math.max(1, Math.min(12, term)) : 12;
  row.className = 'lump-row';
  row.innerHTML = `
    <div class="field"><label for="lump-month-${id}">At month</label><div class="input-wrap"><input id="lump-month-${id}" type="number" min="1" max="600" step="1" value="${month}" aria-label="${label} lump sum ${id} month" data-lump-month></div></div>
    <div class="field"><label for="lump-amount-${id}">Amount</label><div class="input-wrap"><span data-currency>${symbol()}</span><input id="lump-amount-${id}" type="number" min="0" max="1000000000" step="0.01" value="1000" aria-label="${label} lump sum ${id} amount" data-lump-amount></div></div>
    <button class="remove-lump" type="button" aria-label="Remove ${label.toLowerCase()} lump sum ${id}">×</button>`;
  row.querySelector('button').addEventListener('click', () => {
    row.remove();
    render();
    $(`add-${kind}-lump`).focus();
  });
  $(`${kind}-lumps`).append(row);
  render();
  row.querySelector('input').focus();
}

function downloadSchedule() {
  if (!result || $('download').disabled) return;
  const header = [
    'Model year', `Baseline closing balance (${currency})`, `Overpayment closing balance (${currency})`,
    `Overpayment plan interest (${currency})`, `Actual overpayments (${currency})`,
    `Eligible overpayments (${currency})`, `Annual allowance (${currency})`, `Allowance exceeded (${currency})`,
  ];
  const rows = result.overpaid.years.map((year, i) => [
    year.year, result.baseline.years[i].closing.toFixed(2), year.closing.toFixed(2),
    year.interest.toFixed(2), year.extra.toFixed(2),
    ...(year.active ? [year.countedExtra.toFixed(2), year.allowance.toFixed(2), year.excess.toFixed(2)] : ['', '', '']),
  ]);
  const csv = [header, ...rows].map(row => row.join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `hearth-mortgage-schedule-${currency.toLowerCase()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

form.addEventListener('submit', event => event.preventDefault());
form.addEventListener('input', () => {
  if (pendingRender) return;
  pendingRender = true;
  requestAnimationFrame(() => {
    pendingRender = false;
    render();
  });
});
form.addEventListener('change', render);
$('currency').addEventListener('change', () => {
  currency = $('currency').value;
  render();
});
$('reset').addEventListener('click', () => {
  form.reset();
  $('mortgage-lumps').replaceChildren();
  $('investment-lumps').replaceChildren();
  $('currency').value = currency = 'GBP';
  $('chart-month').value = 0;
  switchTab('mortgage');
});
document.querySelectorAll('[data-tab]').forEach(button => {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
  button.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      let tab = activeTab === 'mortgage' ? 'investment' : 'mortgage';
      if (event.key === 'Home') tab = 'mortgage';
      if (event.key === 'End') tab = 'investment';
      switchTab(tab, true);
    }
  });
});
$('add-mortgage-lump').addEventListener('click', () => addLump('mortgage'));
$('add-investment-lump').addEventListener('click', () => addLump('investment'));
$('compare-button').addEventListener('click', () => {
  switchTab('investment', true);
  $('calculator').scrollIntoView({ block: 'start' });
});
$('edit-overpayments').addEventListener('click', () => {
  switchTab('mortgage');
  $('monthlyExtra').focus();
});
$('chart-month').addEventListener('input', renderChartValues);
$('download').addEventListener('click', downloadSchedule);
window.addEventListener('resize', () => {
  if (result && !$('results').inert) renderChart(currentConfig);
});
render();
