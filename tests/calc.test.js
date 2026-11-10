const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/calc.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('American ↔ decimal odds', () => {
  close(C.americanToDecimal(-110), 1 + 100 / 110);
  close(C.americanToDecimal(150), 2.5);
  close(C.americanToDecimal(100), 2);
  assert.ok(Number.isNaN(C.americanToDecimal(50)));
  assert.equal(C.decimalToAmerican(2.5), 150);
  assert.equal(C.decimalToAmerican(1.5), -200);
  assert.equal(C.formatOdds(C.americanToDecimal(-110), 'american'), '-110');
  assert.equal(C.formatOdds(2.5, 'american'), '+150');
  close(C.parseOdds('+150', 'american'), 2.5);
  close(C.parseOdds('1.91', 'decimal'), 1.91);
  assert.ok(Number.isNaN(C.parseOdds('0.9', 'decimal')));
});

test('bet profit by status', () => {
  const base = { stake: 110, odds: C.americanToDecimal(-110), units: 1.1 };
  close(C.betProfit({ ...base, status: 'won' }), 100);
  assert.equal(C.betProfit({ ...base, status: 'lost' }), -110);
  assert.equal(C.betProfit({ ...base, status: 'push' }), 0);
  assert.equal(C.betProfit({ ...base, status: 'void' }), 0);
  assert.equal(C.betProfit({ ...base, status: 'pending' }), 0);
  assert.equal(C.betProfit({ ...base, status: 'cashout', cashout: 150 }), 40);
  close(C.betUnitsProfit({ ...base, status: 'won' }), 1);
});

test('summarize computes P&L, ROI, win rate and streaks', () => {
  const bets = [
    { date: '2026-01-01', stake: 100, units: 1, odds: 2, status: 'won' },
    { date: '2026-01-02', stake: 100, units: 1, odds: 2, status: 'won' },
    { date: '2026-01-03', stake: 100, units: 1, odds: 2, status: 'lost' },
    { date: '2026-01-04', stake: 100, units: 1, odds: 2, status: 'push' },
    { date: '2026-01-05', stake: 100, units: 1, odds: 2, status: 'void' },
    { date: '2026-01-06', stake: 50, units: 0.5, odds: 2, status: 'pending' },
  ];
  const s = C.summarize(bets);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.pushes, 1);
  assert.equal(s.graded, 4); // void excluded
  assert.equal(s.staked, 400);
  assert.equal(s.profit, 100);
  assert.equal(s.units, 1);
  close(s.roi, 0.25);
  close(s.winRate, 2 / 3);
  assert.equal(s.pending, 1);
  assert.equal(s.pendingStake, 50);
  assert.equal(s.longestWinStreak, 2);
  assert.deepEqual(s.currentStreak, { type: 'lost', length: 1 });
});

test('bankroll series tracks peak and drawdown in date order', () => {
  const bets = [
    { date: '2026-01-03', stake: 100, odds: 2, status: 'lost' },
    { date: '2026-01-01', stake: 100, odds: 2, status: 'won' },
    { date: '2026-01-02', stake: 100, odds: 2, status: 'lost' },
  ];
  const s = C.bankrollSeries(1000, bets);
  assert.deepEqual(s.points.map((p) => p.bankroll), [1000, 1100, 1000, 900]);
  assert.equal(s.peak, 1100);
  assert.equal(s.maxDrawdown, 200);
  close(s.maxDrawdownPct, 200 / 1100);
});

test('groupSummary groups and sorts by profit', () => {
  const g = C.groupSummary([
    { sport: 'NBA', stake: 10, odds: 2, status: 'lost' },
    { sport: 'NFL', stake: 10, odds: 2, status: 'won' },
    { sport: '', stake: 10, odds: 2, status: 'won' },
  ], 'sport');
  assert.deepEqual(g.map((x) => x.name), ['NFL', 'Other', 'NBA']);
});

test('unit size follows the chosen basis', () => {
  const s = { startingBankroll: 1000, unitPct: 2, unitBasis: 'starting' };
  assert.equal(C.unitSize(s, 500), 20);
  assert.equal(C.unitSize({ ...s, unitBasis: 'current' }, 500), 10);
});

test('Kelly fraction', () => {
  close(C.kellyFraction(0.55, 2), 0.1); // (1*0.55 - 0.45) / 1
  assert.ok(C.kellyFraction(0.45, 2) < 0);
});

test('recommendStake: Kelly sizing, cap, and pass', () => {
  // 0.55 at even money: full Kelly 10% → quarter Kelly 2.5% of $1000 = $25 = 1.25u at $20/u
  const r = C.recommendStake({ bankroll: 1000, unit: 20, odds: 2, winProb: 0.55, kellyMultiplier: 0.25, maxUnits: 3 });
  assert.equal(r.method, 'kelly');
  assert.equal(r.units, 1.25);
  assert.equal(r.stake, 25);
  close(r.ev, 0.1);

  const big = C.recommendStake({ bankroll: 1000, unit: 20, odds: 2, winProb: 0.7, kellyMultiplier: 1, maxUnits: 3 });
  assert.equal(big.units, 3);
  assert.ok(big.capped);

  const pass = C.recommendStake({ bankroll: 1000, unit: 20, odds: C.americanToDecimal(-110), winProb: 0.5 });
  assert.ok(pass.pass);
  assert.equal(pass.units, 0);
});

test('recommendStake: confidence sizing without a win probability', () => {
  const r = C.recommendStake({ bankroll: 1000, unit: 20, odds: 1.91, confidence: 4, maxUnits: 3 });
  assert.equal(r.method, 'confidence');
  assert.equal(r.units, 2);
  assert.equal(r.stake, 40);
  const capped = C.recommendStake({ bankroll: 1000, unit: 20, odds: 1.91, confidence: 5, maxUnits: 2 });
  assert.equal(capped.units, 2);
});

test('unitAdvice flags an oversized unit and a drawdown on a fixed basis', () => {
  const settings = { startingBankroll: 1000, unitPct: 10, unitBasis: 'starting' };
  const bets = [{ date: '2026-01-01', stake: 300, units: 3, odds: 2, status: 'lost' }];
  const a = C.unitAdvice(settings, bets);
  const levels = a.messages.map((m) => m.level);
  assert.ok(levels.includes('critical'));
  assert.ok(levels.includes('serious'));
  assert.equal(a.suggestedPct, 3);
});

test('CSV export escapes fields and includes profit', () => {
  const csv = C.toCSV([{ date: '2026-01-01', event: 'A, "B"', stake: 10, odds: 2, status: 'won' }]);
  const [header, row] = csv.split('\n');
  assert.equal(header, C.CSV_FIELDS.join(','));
  assert.ok(row.includes('"A, ""B"""'));
  assert.ok(row.includes(',10,'));
});

test('betFormat: explicit format, or parlay inferred from older bets', () => {
  assert.equal(C.betFormat({ format: 'Parlay' }), 'Parlay');
  assert.equal(C.betFormat({ format: 'Single', event: '3-leg parlay' }), 'Single');
  assert.equal(C.betFormat({ type: 'Parlay' }), 'Parlay');
  assert.equal(C.betFormat({ type: 'Spread', event: 'Chiefs vs Bills' }), 'Single');
  assert.equal(C.betFormat({}), 'Single');
});

test('dailySummary groups profit by day and counts open bets separately', () => {
  const d = C.dailySummary([
    { date: '2026-04-01', stake: 100, units: 1, odds: 2, status: 'won' },
    { date: '2026-04-01', stake: 50, units: 0.5, odds: 2, status: 'lost' },
    { date: '2026-04-02', stake: 20, odds: 2, status: 'pending' },
    { date: '2026-04-02', stake: 20, odds: 2, status: 'void' },
    { date: 'bad', stake: 20, odds: 2, status: 'won' },
  ]);
  assert.deepEqual(Object.keys(d).sort(), ['2026-04-01', '2026-04-02']);
  assert.equal(d['2026-04-01'].profit, 50);
  assert.equal(d['2026-04-01'].units, 0.5);
  assert.equal(d['2026-04-01'].wins, 1);
  assert.equal(d['2026-04-01'].losses, 1);
  assert.equal(d['2026-04-02'].pending, 1);
  assert.equal(d['2026-04-02'].graded, 0);
  assert.equal(d['2026-04-02'].bets, 2);
});
