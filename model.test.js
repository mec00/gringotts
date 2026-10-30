import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate, defaults, monthlyPayment } from './model.js';

const config = changes => ({ ...structuredClone(defaults), ...changes });
const close = (actual, expected, tolerance = 0.01) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);

test('standard repayment formula and zero-interest branch', () => {
  close(monthlyPayment(200000, 6, 360), 1199.10105);
  close(monthlyPayment(12000, 0, 12), 1000);
});

test('no overpayments reproduces baseline and both investment strategies', () => {
  const result = calculate(config({ upfrontExtra: 0, monthlyExtra: 0 }));
  close(result.interestSaved, 0);
  assert.equal(result.monthsSaved, 0);
  close(result.comparison.difference, 0);
  assert.equal(result.breakEven, null);
});

test('zero-interest mortgage pays off early and redirects freed cash', () => {
  const result = calculate(config({
    balance: 12000, termMonths: 12, fixedMonths: 12, fixedRate: 0,
    monthlyExtra: 1000, upfrontExtra: 0, annualReturn: 0,
  }));
  assert.equal(result.overpaid.payoffMonth, 6);
  close(result.overpaid.totalExtra, 6000);
  close(result.comparison.overpayPortfolio, 12000);
  close(result.comparison.investPortfolio, 12000);
  close(result.comparison.difference, 0);
});

test('rate change resets the reference payment, keeping overpayments term-reducing', () => {
  const result = calculate(config({
    balance: 100000, termMonths: 120, fixedMonths: 24, fixedRate: 2,
    variableRate: 7, monthlyExtra: 100, upfrontExtra: 0,
  }));
  const expected = monthlyPayment(result.baseline.rows[24].balance, 7, 96);
  close(result.baseline.rows[25].payment, expected);
  close(result.overpaid.rows[25].payment, expected);
  assert.ok(result.monthsSaved > 0);
  close(result.baseline.rows.at(-1).balance, 0);
});

test('upfront and duplicate scheduled lump sums count against annual allowance', () => {
  const result = calculate(config({
    balance: 100000, termMonths: 120, fixedMonths: 24, monthlyExtra: 500,
    upfrontExtra: 5000, lumps: [{ month: 12, amount: 1000 }, { month: 12, amount: 2000 }],
    limitPercent: 10, limitBasis: 'original',
  }));
  close(result.overpaid.years[0].countedExtra, 14000);
  close(result.overpaid.years[0].excess, 4000);
  assert.equal(result.breaches[0].year, 1);
  close(result.overpaid.years[1].countedExtra, 6000);
});

test('opening-balance allowance resets annually and fixed-only expiry is respected', () => {
  const result = calculate(config({
    fixedMonths: 14, upfrontExtra: 0, monthlyExtra: 1000, limitPercent: 1,
  }));
  close(result.overpaid.years[1].allowance, result.overpaid.rows[12].balance * 0.01);
  close(result.overpaid.years[1].countedExtra, 2000);
  assert.equal(result.overpaid.years[2].active, false);
  assert.equal(calculate(config({ limitPeriod: 'none' })).breaches.length, 0);
});

test('only actual overpayments count and excess upfront money is invested', () => {
  const result = calculate(config({
    balance: 1000, termMonths: 12, fixedMonths: 12, fixedRate: 0,
    upfrontExtra: 2000, monthlyExtra: 0, annualReturn: 0,
  }));
  assert.equal(result.overpaid.payoffMonth, 0);
  close(result.overpaid.totalExtra, 1000);
  close(result.comparison.rows[0].overpayPortfolio, 1000);
  close(result.comparison.overpayPortfolio, 2000);
  close(result.comparison.difference, 0);
});

test('annual effective investment return compounds monthly; deposits are at month end', () => {
  const result = calculate(config({
    termMonths: 12, fixedMonths: 12, upfrontExtra: 1000, monthlyExtra: 100,
    startingBalance: 2000, annualReturn: 12,
  }));
  const rate = 1.12 ** (1 / 12) - 1;
  close(result.comparison.investPortfolio, 3000 * 1.12 + 100 * ((1.12 - 1) / rate));
});

test('short-horizon comparison subtracts outstanding mortgage debt', () => {
  const result = calculate(config({ fullHorizon: false, horizonMonths: 60 }));
  const comparison = result.comparison;
  close(comparison.overpayNet, comparison.overpayPortfolio - result.overpaid.rows[60].balance);
  close(comparison.investNet, comparison.investPortfolio - result.baseline.rows[60].balance);
  assert.ok(result.baseline.rows[60].balance > 0);
});

test('investment matches mortgage at its effective annual rate', () => {
  const effective = ((1 + 6 / 1200) ** 12 - 1) * 100;
  const result = calculate(config({
    fixedRate: 6, variableRate: 6, annualReturn: effective,
    lumps: [{ month: 48, amount: 7000 }],
  }));
  close(result.comparison.difference, 0);
  close(result.annual.net, result.comparison.investNet);
  close(result.breakEven, effective, 0.00001);
});

test('lower investment return favours overpayment, higher return favours investing', () => {
  assert.ok(calculate(config({ annualReturn: 0 })).comparison.difference < 0);
  assert.ok(calculate(config({ annualReturn: 12 })).comparison.difference > 0);
  assert.ok(calculate(config({ annualReturn: -20 })).comparison.investPortfolio >= 0);
});

test('unequal amounts or contribution timing disable fair-comparison status', () => {
  const result = calculate(config({ matchContributions: false, monthlyInvestment: 400 }));
  assert.equal(result.comparison.equalBudgets, false);
  assert.equal(result.breakEven, null);
  const shifted = calculate(config({
    matchContributions: false, lumps: [{ month: 1, amount: 500 }],
    investmentLumps: [{ month: 2, amount: 500 }],
  }));
  assert.equal(shifted.comparison.equalBudgets, false);
  close(shifted.comparison.overpayBudget, shifted.comparison.investBudget);
});

test('partial final month and post-payoff lump sums preserve budget', () => {
  const result = calculate(config({
    balance: 10500, termMonths: 12, fixedMonths: 0, variableRate: 0,
    upfrontExtra: 0, monthlyExtra: 2000, annualReturn: 0,
    lumps: [{ month: 10, amount: 5000 }],
  }));
  close(result.comparison.difference, 0);
  close(result.comparison.investPortfolio, 29000);
  close(result.overpaid.rows.at(-1).balance, 0);
});

test('invalid inputs are rejected rather than silently coerced', () => {
  for (const changes of [
    { balance: NaN }, { balance: 0 }, { termMonths: 0 }, { termMonths: 1.5 },
    { fixedMonths: 301 }, { annualReturn: -100 }, { monthlyExtra: -1 },
    { limitBasis: 'unknown' }, { fullHorizon: false, horizonMonths: 301 },
    { lumps: [{ month: 0, amount: 200 }] }, { lumps: [{ month: 1, amount: Infinity }] },
  ]) assert.throws(() => calculate(config(changes)), RangeError);
});

test('annual strategy invests contributions and lump sums, then withdraws only at year end', () => {
  const { annual } = calculate(config({
    balance: 36000, termMonths: 36, fixedMonths: 0, variableRate: 0,
    upfrontExtra: 1000, monthlyExtra: 200, annualReturn: 0,
    lumps: [{ month: 6, amount: 600 }, { month: 12, amount: 1200 }, { month: 13, amount: 300 }],
  }));
  close(annual.rows[0].balance, 36000);
  close(annual.rows[0].portfolio, 1000);
  assert.ok(annual.rows.slice(0, 12).every(row => row.extra === 0));
  close(annual.rows[12].extra, 5200);
  close(annual.rows[12].balance, 18800);
  close(annual.rows[12].portfolio, 0);
  close(annual.rows[13].portfolio, 500);
  close(annual.rows[24].extra, 2700);
  close(annual.years[1].opening, annual.rows[12].balance);
});

test('annual withdrawals include compounded gains or losses but exclude existing investments', () => {
  for (const annualReturn of [12, -12, 0]) {
    const { annual } = calculate(config({
      balance: 100000, termMonths: 120, fixedMonths: 0, variableRate: 0,
      startingBalance: 5000, upfrontExtra: 1000, monthlyExtra: 100, annualReturn,
      lumps: [{ month: 6, amount: 200 }, { month: 12, amount: 300 }],
    }));
    const growth = (1 + annualReturn / 100) ** (1 / 12) - 1;
    const monthlyPot = growth === 0 ? 1200 : 100 * (((1 + growth) ** 12 - 1) / growth);
    const expected = 1000 * (1 + annualReturn / 100) + monthlyPot + 200 * (1 + growth) ** 6 + 300;
    close(annual.rows[12].extra, expected);
    close(annual.rows[12].portfolio, 5000 * (1 + annualReturn / 100));
    close(annual.rows[24].extra, monthlyPot);
  }
});

test('annual allowances apply on withdrawal, including growth, and respect fixed-period expiry', () => {
  const settings = {
    balance: 100000, termMonths: 120, fixedMonths: 12,
    upfrontExtra: 10000, monthlyExtra: 0, annualReturn: 10, limitPercent: 10,
  };
  const { annual } = calculate(config(settings));
  close(annual.years[0].countedExtra, 11000);
  close(annual.breaches[0].excess, 1000);
  close(annual.years[1].allowance, annual.rows[12].balance * 0.1);
  assert.equal(annual.years[1].active, false);
  const expired = calculate(config({ ...settings, fixedMonths: 11 })).annual;
  assert.equal(expired.breaches.length, 0);
  close(expired.years[0].extra, 11000);
  close(expired.years[0].countedExtra, 0);
});

test('annual payoff caps withdrawals and retains excess funds and freed mortgage payments', () => {
  const { annual, comparison } = calculate(config({
    balance: 24000, termMonths: 24, fixedMonths: 0, variableRate: 0,
    upfrontExtra: 20000, monthlyExtra: 0, annualReturn: 0, startingBalance: 1000,
  }));
  assert.equal(annual.payoffMonth, 12);
  close(annual.rows[12].extra, 12000);
  close(annual.rows[12].portfolio, 9000);
  close(annual.rows[13].portfolio, 10000);
  close(annual.rows[24].extra, 0);
  close(annual.atHorizon.portfolio, 21000);
  close(annual.net, comparison.investNet);
  close(annual.net, comparison.overpayNet);
});

test('short horizons and partial final years do not trigger early annual withdrawals', () => {
  const settings = {
    balance: 18000, termMonths: 18, fixedMonths: 0, variableRate: 0,
    upfrontExtra: 500, monthlyExtra: 100, annualReturn: 0,
  };
  const first = calculate(config({ ...settings, fullHorizon: false, horizonMonths: 6 }));
  close(first.annual.atHorizon.portfolio, 1100);
  close(first.annual.atHorizon.balance, first.baseline.rows[6].balance);
  close(first.annual.net, first.comparison.investNet);
  const second = calculate(config({ ...settings, fullHorizon: false, horizonMonths: 14 }));
  close(second.annual.rows[12].extra, 1700);
  close(second.annual.atHorizon.portfolio, 200);
  close(second.annual.atHorizon.extra, 0);
  close(second.annual.net, second.annual.atHorizon.portfolio - second.annual.atHorizon.balance);
  close(second.annual.rows[18].extra, 0);
});

test('annual strategy uses custom investment amounts and shared rate-reset payments', () => {
  const result = calculate(config({
    matchContributions: false, upfrontInvestment: 2000, monthlyInvestment: 50,
    investmentLumps: [{ month: 12, amount: 400 }], annualReturn: 0,
    fixedMonths: 12, fixedRate: 2, variableRate: 7,
  }));
  close(result.annual.rows[12].extra, 3000);
  close(result.annual.rows[13].payment, result.baseline.rows[13].payment);
  assert.equal(result.comparison.equalBudgets, false);
  assert.ok(result.annual.interestSaved > 0);
  assert.ok(result.annual.monthsSaved > 0);
});

test('annual strategy preserves the baseline with no new contributions', () => {
  const result = calculate(config({ monthlyExtra: 0, upfrontExtra: 0, startingBalance: 5000 }));
  close(result.annual.totalExtra, 0);
  close(result.annual.interestSaved, 0);
  assert.equal(result.annual.monthsSaved, 0);
  close(result.annual.net, result.comparison.investNet);
});
