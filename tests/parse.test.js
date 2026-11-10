const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/parse.js');

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const opts = { today: '2026-11-10' };

test('typed single: stake, odds, book, result and name', () => {
  const [b] = P.parseBets('$25 on Chiefs ML -110 at FanDuel, won', opts);
  assert.equal(b.format, 'Single');
  assert.equal(b.event, 'Chiefs ML');
  assert.equal(b.stake, 25);
  close(b.odds, 1 + 100 / 110);
  assert.equal(b.book, 'FanDuel');
  assert.equal(b.status, 'won');
  assert.deepEqual(b.warnings, []);
});

test('typed parlay with legs, slang amount and no name', () => {
  const [b] = P.parseBets('3 leg parlay +596 10 bucks sleeper lost', opts);
  assert.equal(b.format, 'Parlay');
  assert.equal(b.legs, 3);
  close(b.odds, 6.96);
  assert.equal(b.stake, 10);
  assert.equal(b.book, 'Sleeper');
  assert.equal(b.status, 'lost');
  assert.equal(b.event, '');
});

test('"to win" amount is not the result, and sets the price', () => {
  const [b] = P.parseBets('Lakers +150, $20 to win $30 on DraftKings', opts);
  assert.equal(b.status, 'pending');
  assert.equal(b.stake, 20);
  close(b.odds, 2.5);
  assert.equal(b.event, 'Lakers');
  assert.equal(b.book, 'DraftKings');
});

test('several bets, one per line', () => {
  const bets = P.parseBets('Chiefs -110 $22 won\nBills +130 $10 lost\nfour leg parlay +1200 $5 pending chalkboard', opts);
  assert.equal(bets.length, 3);
  assert.deepEqual(bets.map((b) => b.status), ['won', 'lost', 'pending']);
  assert.equal(bets[2].format, 'Parlay');
  assert.equal(bets[2].legs, 4);
  assert.equal(bets[2].book, 'Chalkboard');
});

test('Fliff is recognised as a sportsbook', () => {
  const [b] = P.parseBets('Knicks +140 $15 on Fliff', opts);
  assert.equal(b.book, 'Fliff');
  assert.equal(b.event, 'Knicks');
});

test('units, word odds and dates', () => {
  const [b] = P.parseBets('2u on Celtics minus 120 yesterday', opts);
  assert.equal(b.units, 2);
  assert.equal(b.stake, null);
  close(b.odds, 1 + 100 / 120);
  assert.equal(b.date, '2026-11-09');
  const [c] = P.parseBets('Nov 3 Rangers +105 $15 push', opts);
  assert.equal(c.date, '2026-11-03');
  assert.equal(c.status, 'push');
});

test('missing sign is assumed and flagged; spreads are not odds', () => {
  const [b] = P.parseBets('Chiefs -3.5 at 110 for $30', opts);
  close(b.odds, 1 + 100 / 110);
  assert.equal(b.stake, 30);
  assert.ok(b.warnings.some((w) => /assumed/.test(w)));
  assert.match(b.event, /Chiefs -3.5/);
});

test('cash out', () => {
  const [b] = P.parseBets('parlay +400 $10 cashed out for $28', opts);
  assert.equal(b.status, 'cashout');
  assert.equal(b.cashout, 28);
  assert.equal(b.stake, 10);
});

test('nothing usable gives warnings, not a crash', () => {
  const [b] = P.parseBets('good luck tonight', opts);
  assert.ok(b.warnings.includes('Odds not found.'));
  assert.ok(b.warnings.includes('Stake not found.'));
  assert.deepEqual(P.parseBets('   ', opts), []);
});

test('bet slip text from a screenshot', () => {
  const slip = [
    '3 Leg Parlay  +596',
    'Kansas City Chiefs -150',
    'Moneyline',
    'Buffalo Bills +120',
    'Detroit Lions -200',
    'Wager $10.00',
    'To Win $59.60',
    'WON',
  ].join('\n');
  const [b] = P.parseSlip(slip, opts);
  assert.equal(b.format, 'Parlay');
  assert.equal(b.legs, 3);
  assert.equal(b.stake, 10);
  close(b.odds, 6.96);
  assert.equal(b.status, 'won');
  assert.equal(b.event, 'Kansas City Chiefs / Buffalo Bills / Detroit Lions');
});

test('slip with two bets splits on each wager', () => {
  const slip = 'Celtics -120\nWager $12.00\nTo Win $10.00\nNuggets +110\nWager $5.00\nPayout $10.50';
  const bets = P.parseSlip(slip, opts);
  assert.equal(bets.length, 2);
  assert.equal(bets[0].stake, 12);
  close(bets[0].odds, 1 + 10 / 12);
  assert.equal(bets[1].stake, 5);
  close(bets[1].odds, 2.1);
});
