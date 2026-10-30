export const defaults = {
  balance: 285000,
  termMonths: 300,
  fixedRate: 4.25,
  fixedMonths: 24,
  variableRate: 5.5,
  monthlyExtra: 250,
  upfrontExtra: 5000,
  lumps: [],
  limitPercent: 10,
  limitBasis: 'opening',
  limitPeriod: 'fixed',
  annualReturn: 6,
  startingBalance: 0,
  matchContributions: true,
  monthlyInvestment: 250,
  upfrontInvestment: 5000,
  investmentLumps: [],
  fullHorizon: true,
  horizonMonths: 300,
};

function checkNumber(value, name, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}.`);
  }
}

export function validate(config) {
  checkNumber(config.balance, 'Outstanding balance', 1, 1e9);
  checkNumber(config.termMonths, 'Remaining term in months', 1, 600, true);
  checkNumber(config.fixedMonths, 'Fixed period in months', 0, config.termMonths, true);
  for (const key of ['fixedRate', 'variableRate']) {
    checkNumber(config[key], key === 'fixedRate' ? 'Fixed interest rate' : 'Variable interest rate', 0, 30);
  }
  for (const [key, name] of [
    ['monthlyExtra', 'Monthly overpayment'], ['upfrontExtra', 'Upfront overpayment'],
    ['startingBalance', 'Starting investment balance'], ['monthlyInvestment', 'Monthly investment'],
    ['upfrontInvestment', 'Upfront investment'],
  ]) {
    checkNumber(config[key], name, 0, 1e9);
  }
  checkNumber(config.limitPercent, 'Annual overpayment allowance', 0, 100);
  checkNumber(config.annualReturn, 'Annual investment return', -99, 50);
  if (!config.fullHorizon) checkNumber(config.horizonMonths, 'Comparison horizon in months', 1, config.termMonths, true);
  if (!['opening', 'original'].includes(config.limitBasis)) throw new RangeError('Choose a valid allowance basis.');
  if (!['fixed', 'all', 'none'].includes(config.limitPeriod)) throw new RangeError('Choose a valid allowance period.');
  if (typeof config.matchContributions !== 'boolean' || typeof config.fullHorizon !== 'boolean') {
    throw new TypeError('Comparison options must be true or false.');
  }
  for (const [key, name] of [['lumps', 'Mortgage lump sum'], ['investmentLumps', 'Investment lump sum']]) {
    if (!Array.isArray(config[key])) throw new TypeError(`${name} schedule must be a list.`);
    for (const lump of config[key]) {
      checkNumber(lump.month, `${name} month`, 1, config.termMonths, true);
      checkNumber(lump.amount, `${name} amount`, 0, 1e9);
    }
  }
}

export function monthlyPayment(balance, annualRate, months) {
  if (balance === 0) return 0;
  const rate = annualRate / 1200;
  return rate === 0 ? balance / months : balance * rate / -Math.expm1(-months * Math.log1p(rate));
}

function lumpMap(lumps) {
  const map = new Map();
  for (const { month, amount } of lumps) map.set(month, (map.get(month) || 0) + amount);
  return map;
}

function investmentContributions(config) {
  return {
    monthly: config.matchContributions ? config.monthlyExtra : config.monthlyInvestment,
    upfront: config.matchContributions ? config.upfrontExtra : config.upfrontInvestment,
    lumps: lumpMap(config.matchContributions ? config.lumps : config.investmentLumps),
  };
}

function monthlyGrowthRate(annualReturn) {
  return Math.expm1(Math.log1p(annualReturn / 100) / 12);
}

function mortgage(config, baseline = null, strategy = 'monthly') {
  const annual = strategy === 'annual';
  const overpay = baseline !== null && !annual;
  const initialExtra = overpay ? Math.min(config.balance, config.upfrontExtra) : 0;
  const investment = investmentContributions(config);
  const growth = monthlyGrowthRate(config.annualReturn);
  let investmentPot = annual ? investment.upfront : 0;
  let retainedInvestments = annual ? config.startingBalance : 0;
  let balance = config.balance - initialExtra;
  let payment = 0;
  let totalInterest = 0;
  let totalExtra = initialExtra;
  let payoffMonth = balance === 0 ? 0 : config.termMonths;
  const rows = [{
    month: 0, balance, interest: 0, payment: 0, extra: initialExtra, totalInterest: 0,
    ...(annual ? { portfolio: retainedInvestments + investmentPot } : {}),
  }];
  const years = [];
  const lumps = lumpMap(config.lumps);

  for (let month = 1; month <= config.termMonths; month++) {
    const rate = month <= config.fixedMonths ? config.fixedRate : config.variableRate;
    if (baseline) {
      payment = baseline.rows[month].payment;
    } else if (month === 1 || month === config.fixedMonths + 1) {
      payment = monthlyPayment(balance, rate, config.termMonths - month + 1);
    }
    if ((month - 1) % 12 === 0) {
      const opening = month === 1 ? config.balance : balance;
      years.push({
        year: years.length + 1,
        opening,
        allowance: (config.limitBasis === 'original' ? config.balance : opening) * config.limitPercent / 100,
        countedExtra: 0,
        extra: 0,
        interest: 0,
        closing: balance,
        active: false,
        excess: 0,
      });
    }
    const year = years.at(-1);
    const interest = balance * rate / 1200;
    const regular = Math.min(balance + interest, payment);
    let requestedExtra = overpay ? config.monthlyExtra + (lumps.get(month) || 0) : 0;
    if (annual) {
      retainedInvestments *= 1 + growth;
      investmentPot = investmentPot * (1 + growth) + investment.monthly +
        (investment.lumps.get(month) || 0) + Math.max(0, payment - regular);
      if (month % 12 === 0) requestedExtra = investmentPot;
    }
    const extra = Math.min(Math.max(0, balance + interest - regular), requestedExtra);
    if (annual) investmentPot -= extra;
    balance = Math.max(0, balance + interest - regular - extra);
    if (balance < 1e-7) balance = 0;
    totalInterest += interest;
    totalExtra += extra;
    const allowanceActive = config.limitPeriod === 'all' ||
      (config.limitPeriod === 'fixed' && month <= config.fixedMonths);
    const annualExtra = extra + (month === 1 ? initialExtra : 0);
    year.extra += annualExtra;
    year.interest += interest;
    year.closing = balance;
    if (annual) year.portfolio = retainedInvestments + investmentPot;
    if (allowanceActive) {
      year.active = true;
      year.countedExtra += annualExtra;
      year.excess = Math.max(0, year.countedExtra - year.allowance);
    }
    if (balance === 0 && rows.at(-1).balance > 0) payoffMonth = month;
    rows.push({
      month, balance, interest, payment: regular, extra, totalInterest,
      ...(annual ? { portfolio: retainedInvestments + investmentPot } : {}),
    });
  }
  return { rows, years, totalInterest, totalExtra, payoffMonth, initialExtra };
}

function projectInvestments(config, baseline, overpaid, annualReturn) {
  const horizon = config.fullHorizon ? config.termMonths : config.horizonMonths;
  const growth = monthlyGrowthRate(annualReturn);
  const mortgageLumps = lumpMap(config.lumps);
  const investment = investmentContributions(config);
  let overpayPortfolio = config.startingBalance + config.upfrontExtra - overpaid.initialExtra;
  let investPortfolio = config.startingBalance + investment.upfront;
  let equalBudgets = Math.abs(investment.upfront - config.upfrontExtra) < 0.005;
  let overpayBudget = config.upfrontExtra;
  let investBudget = investment.upfront;
  const rows = [{
    month: 0,
    overpayPortfolio,
    investPortfolio,
    overpayNet: overpayPortfolio - overpaid.rows[0].balance,
    investNet: investPortfolio - baseline.rows[0].balance,
  }];
  for (let month = 1; month <= horizon; month++) {
    const extraBudget = config.monthlyExtra + (mortgageLumps.get(month) || 0);
    const investmentContribution = investment.monthly + (investment.lumps.get(month) || 0);
    equalBudgets &&= Math.abs(extraBudget - investmentContribution) < 0.005;
    overpayBudget += extraBudget;
    investBudget += investmentContribution;
    // Both strategies retain the baseline payment budget, even after early payoff.
    const releasedCash = Math.max(0, baseline.rows[month].payment + extraBudget -
      overpaid.rows[month].payment - overpaid.rows[month].extra);
    overpayPortfolio = overpayPortfolio * (1 + growth) + releasedCash;
    investPortfolio = investPortfolio * (1 + growth) + investmentContribution;
    rows.push({
      month,
      overpayPortfolio,
      investPortfolio,
      overpayNet: overpayPortfolio - overpaid.rows[month].balance,
      investNet: investPortfolio - baseline.rows[month].balance,
    });
  }
  const last = rows.at(-1);
  return {
    rows, horizon, equalBudgets, overpayBudget, investBudget,
    ...last,
    difference: last.investNet - last.overpayNet,
  };
}

export function calculate(config) {
  validate(config);
  const baseline = mortgage(config);
  const overpaid = mortgage(config, baseline);
  const comparison = projectInvestments(config, baseline, overpaid, config.annualReturn);
  const annual = mortgage(config, baseline, 'annual');
  annual.interestSaved = Math.max(0, baseline.totalInterest - annual.totalInterest);
  annual.monthsSaved = baseline.payoffMonth - annual.payoffMonth;
  annual.breaches = annual.years.filter(year => year.excess > 0.005);
  annual.atHorizon = annual.rows[comparison.horizon];
  annual.net = annual.atHorizon.portfolio - annual.atHorizon.balance;
  const breaches = overpaid.years.filter(year => year.excess > 0.005);
  let breakEven = null;
  if (comparison.equalBudgets && comparison.overpayBudget > 0) {
    let low = -99;
    let high = 50;
    const differenceAt = rate => projectInvestments(config, baseline, overpaid, rate).difference;
    if (differenceAt(low) < -0.005 && differenceAt(high) > 0.005) {
      for (let i = 0; i < 45; i++) {
        const mid = (low + high) / 2;
        if (differenceAt(mid) > 0) high = mid;
        else low = mid;
      }
      breakEven = (low + high) / 2;
    }
  }
  return {
    baseline, overpaid, annual, comparison, breaches, breakEven,
    interestSaved: Math.max(0, baseline.totalInterest - overpaid.totalInterest),
    monthsSaved: baseline.payoffMonth - overpaid.payoffMonth,
  };
}
