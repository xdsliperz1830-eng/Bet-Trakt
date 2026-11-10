/*
 * Bet-Trakt core math. Pure functions only (no DOM), so the same file runs in
 * the browser (exposed as window.BetCalc) and in Node for the tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BetCalc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATUSES = ['pending', 'won', 'lost', 'push', 'void', 'cashout'];

  /* ---------- Odds ---------- */

  function americanToDecimal(american) {
    const a = Number(american);
    if (!Number.isFinite(a) || (a > -100 && a < 100)) return NaN;
    return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
  }

  function decimalToAmerican(decimal) {
    const d = Number(decimal);
    if (!Number.isFinite(d) || d <= 1) return NaN;
    return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
  }

  /** Parse user-entered odds in the given format and return decimal odds (NaN if invalid). */
  function parseOdds(input, format) {
    const n = Number(String(input).trim().replace(/^\+/, ''));
    if (!Number.isFinite(n)) return NaN;
    if (format === 'decimal') return n > 1 ? n : NaN;
    return americanToDecimal(n);
  }

  function formatOdds(decimal, format) {
    if (!Number.isFinite(decimal)) return '—';
    if (format === 'decimal') return decimal.toFixed(2);
    const a = decimalToAmerican(decimal);
    return a > 0 ? '+' + a : String(a);
  }

  /** Break-even win probability for the given decimal odds. */
  function impliedProbability(decimal) {
    return decimal > 1 ? 1 / decimal : NaN;
  }

  /* ---------- Single bet ---------- */

  /** Profit/loss in dollars for one bet. Pending and void bets return 0. */
  function betProfit(bet) {
    const stake = Number(bet.stake) || 0;
    switch (bet.status) {
      case 'won':
        return stake * (Number(bet.odds) - 1);
      case 'lost':
        return -stake;
      case 'cashout':
        return (Number(bet.cashout) || 0) - stake;
      default:
        return 0; // pending, push, void
    }
  }

  /** Profit in units, using the unit size recorded when the bet was placed. */
  function betUnitsProfit(bet) {
    const stake = Number(bet.stake) || 0;
    const units = Number(bet.units) || 0;
    if (stake <= 0 || units <= 0) return 0;
    return (betProfit(bet) / stake) * units;
  }

  function isSettled(bet) {
    return bet.status !== 'pending';
  }

  /** Settled bets that actually had money at risk (void bets are refunded and ignored). */
  function isGraded(bet) {
    return isSettled(bet) && bet.status !== 'void';
  }

  /* ---------- Ordering ---------- */

  function byDate(a, b) {
    const da = String(a.date || '');
    const db = String(b.date || '');
    if (da !== db) return da < db ? -1 : 1;
    return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
  }

  /* ---------- Aggregates ---------- */

  function round(n, places) {
    const f = Math.pow(10, places == null ? 2 : places);
    return Math.round((n + Number.EPSILON) * f) / f;
  }

  /**
   * Summary statistics for a list of bets.
   * ROI = profit / amount staked on graded bets. Win rate excludes pushes.
   */
  function summarize(bets) {
    const graded = bets.filter(isGraded).slice().sort(byDate);
    const pending = bets.filter((b) => b.status === 'pending');

    let wins = 0, losses = 0, pushes = 0, cashouts = 0;
    let staked = 0, profit = 0, units = 0, oddsSum = 0;
    let streak = 0, streakType = null, bestWin = 0, worstLoss = 0;

    for (const b of graded) {
      const p = betProfit(b);
      staked += Number(b.stake) || 0;
      profit += p;
      units += betUnitsProfit(b);
      oddsSum += Number(b.odds) || 0;

      if (b.status === 'won') wins++;
      else if (b.status === 'lost') losses++;
      else if (b.status === 'push') pushes++;
      else if (b.status === 'cashout') cashouts++;

      // Streaks count only clear wins and losses.
      if (b.status === 'won' || b.status === 'lost') {
        if (b.status === streakType) streak++;
        else { streakType = b.status; streak = 1; }
        if (streakType === 'won') bestWin = Math.max(bestWin, streak);
        else worstLoss = Math.max(worstLoss, streak);
      }
    }

    const decided = wins + losses;
    return {
      count: bets.length,
      graded: graded.length,
      wins, losses, pushes, cashouts,
      pending: pending.length,
      pendingStake: pending.reduce((s, b) => s + (Number(b.stake) || 0), 0),
      staked,
      profit,
      units,
      roi: staked > 0 ? profit / staked : 0,
      winRate: decided > 0 ? wins / decided : 0,
      avgOdds: graded.length ? oddsSum / graded.length : NaN,
      currentStreak: streakType ? { type: streakType, length: streak } : null,
      longestWinStreak: bestWin,
      longestLossStreak: worstLoss,
    };
  }

  /** Summaries grouped by a field (e.g. 'sport', 'type'). Sorted by profit, best first. */
  function groupSummary(bets, key) {
    const groups = new Map();
    for (const b of bets) {
      const k = (b[key] && String(b[key]).trim()) || 'Other';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    }
    return Array.from(groups, ([name, list]) => Object.assign({ name }, summarize(list)))
      .sort((a, b) => b.profit - a.profit);
  }

  /**
   * Bankroll after each graded bet, in date order, plus the running peak and
   * max drawdown. Point 0 is the starting bankroll.
   */
  function bankrollSeries(startingBankroll, bets) {
    const start = Number(startingBankroll) || 0;
    const graded = bets.filter(isGraded).slice().sort(byDate);
    const points = [{ index: 0, date: graded.length ? graded[0].date : null, bankroll: start, bet: null }];
    let bankroll = start, peak = start, maxDrawdown = 0, maxDrawdownPct = 0;
    graded.forEach((b, i) => {
      bankroll += betProfit(b);
      peak = Math.max(peak, bankroll);
      const dd = peak - bankroll;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
        maxDrawdownPct = peak > 0 ? dd / peak : 0;
      }
      points.push({ index: i + 1, date: b.date, bankroll, bet: b });
    });
    return { points, current: bankroll, peak, maxDrawdown, maxDrawdownPct };
  }

  /* ---------- Unit sizing ---------- */

  const RISK_PROFILES = {
    conservative: { unitPct: 1, label: 'Conservative', note: 'Survives long losing runs; best while you are still proving an edge.' },
    moderate: { unitPct: 2, label: 'Moderate', note: 'The common default for a bettor with a tracked, positive record.' },
    aggressive: { unitPct: 3, label: 'Aggressive', note: 'Faster growth and much deeper drawdowns. Needs a proven edge.' },
  };

  /** Confidence 1–5 maps to a stake in units. */
  const CONFIDENCE_UNITS = { 1: 0.5, 2: 1, 3: 1.5, 4: 2, 5: 3 };

  /**
   * Current dollar value of one unit.
   * basis 'starting' = fixed unit from the starting bankroll;
   * basis 'current'  = unit rescales with the bankroll (shrinks in a drawdown).
   */
  function unitSize(settings, currentBankroll) {
    const pct = (Number(settings.unitPct) || 0) / 100;
    const base = settings.unitBasis === 'current' ? Number(currentBankroll) : Number(settings.startingBankroll);
    return Math.max(0, (Number.isFinite(base) ? base : 0) * pct);
  }

  /** Full-Kelly fraction of bankroll for win probability p at decimal odds d. Negative = no edge. */
  function kellyFraction(p, d) {
    const b = d - 1;
    if (!(b > 0) || !(p > 0 && p < 1)) return NaN;
    return (b * p - (1 - p)) / b;
  }

  /**
   * Recommend a stake for a single bet.
   *
   * opts: { bankroll, unit, odds (decimal), winProb (0–1, optional),
   *         confidence (1–5, optional), kellyMultiplier (e.g. 0.25), maxUnits }
   *
   * With a win probability, sizes by fractional Kelly (and says "pass" when
   * there is no edge). Without one, sizes by confidence. Always capped at maxUnits.
   */
  function recommendStake(opts) {
    const bankroll = Number(opts.bankroll) || 0;
    const unit = Number(opts.unit) || 0;
    const odds = Number(opts.odds);
    const maxUnits = Number(opts.maxUnits) > 0 ? Number(opts.maxUnits) : 3;
    const kellyMult = Number(opts.kellyMultiplier) > 0 ? Number(opts.kellyMultiplier) : 0.25;
    const conf = Math.min(5, Math.max(1, Math.round(Number(opts.confidence) || 2)));
    const p = opts.winProb == null || opts.winProb === '' ? NaN : Number(opts.winProb);

    const out = {
      method: null, units: 0, stake: 0, capped: false, pass: false,
      breakEven: impliedProbability(odds), edge: NaN, ev: NaN, fullKelly: NaN, reasons: [],
    };

    if (!(unit > 0)) {
      out.reasons.push('Set a bankroll and unit size first.');
      return out;
    }
    if (!(odds > 1)) {
      out.reasons.push('Enter valid odds to get a recommendation.');
      return out;
    }

    let units;
    if (p > 0 && p < 1) {
      out.method = 'kelly';
      out.edge = p - out.breakEven;          // probability edge over the market
      out.ev = p * odds - 1;                 // expected profit per $1 staked
      out.fullKelly = kellyFraction(p, odds);
      if (out.fullKelly <= 0) {
        out.pass = true;
        out.reasons.push(
          'No edge: you need better than ' + (out.breakEven * 100).toFixed(1) +
          '% to beat these odds and you estimate ' + (p * 100).toFixed(1) + '%. Pass.'
        );
        return out;
      }
      units = (bankroll * out.fullKelly * kellyMult) / unit;
      out.reasons.push(
        (kellyMult === 1 ? 'Full' : kellyMult + '×') + ' Kelly on a ' + (out.edge * 100).toFixed(1) +
        '-point edge (EV ' + (out.ev >= 0 ? '+' : '') + (out.ev * 100).toFixed(1) + '% per dollar).'
      );
    } else {
      out.method = 'confidence';
      units = CONFIDENCE_UNITS[conf];
      out.reasons.push('Confidence ' + conf + '/5 → ' + units + 'u. Add your win % to size by Kelly instead.');
    }

    if (units > maxUnits) {
      units = maxUnits;
      out.capped = true;
      out.reasons.push('Capped at your ' + maxUnits + 'u max bet.');
    }
    // Round to the nearest quarter unit; anything with an edge is at least 0.25u.
    units = Math.max(0.25, Math.round(units * 4) / 4);
    if (units > maxUnits) units = maxUnits;

    out.units = units;
    out.stake = round(units * unit, 2);
    return out;
  }

  /**
   * Bankroll-level advice on unit size, based on the bankroll and recent form.
   * Returns { suggestedPct, unit, messages[] }.
   */
  function unitAdvice(settings, bets) {
    const series = bankrollSeries(settings.startingBankroll, bets);
    const current = series.current;
    const unit = unitSize(settings, current);
    const pct = Number(settings.unitPct) || 0;
    const start = Number(settings.startingBankroll) || 0;
    const messages = [];
    let suggestedPct = pct;

    const graded = bets.filter(isGraded).slice().sort(byDate);
    const recent = summarize(graded.slice(-20));

    if (!start) {
      return { suggestedPct: RISK_PROFILES.moderate.unitPct, unit: 0, current, messages: [
        { level: 'info', text: 'Enter your starting bankroll in Settings to get unit sizes.' },
      ] };
    }

    if (pct > 5) {
      suggestedPct = 3;
      messages.push({ level: 'critical', text: 'A ' + pct + '% unit is very high. Ten straight losses would cost about ' +
        Math.round((1 - Math.pow(1 - pct / 100, 10)) * 100) + '% of your bankroll. Most bettors use 1–3%.' });
    }

    if (current <= 0) {
      messages.push({ level: 'critical', text: 'Your bankroll is gone. Stop, reset your starting bankroll, and size down.' });
      return { suggestedPct: 1, unit, current, messages };
    }

    const drawdownFromStart = (start - current) / start;
    if (settings.unitBasis !== 'current' && drawdownFromStart >= 0.2) {
      messages.push({ level: 'serious', text: 'You are down ' + Math.round(drawdownFromStart * 100) +
        '% from your starting bankroll, but your unit is still based on it. Base units on your current bankroll ($' +
        current.toFixed(2) + ') to cut your unit to $' + (current * pct / 100).toFixed(2) + '.' });
    }

    if (graded.length >= 20 && recent.roi < -0.1) {
      suggestedPct = Math.min(suggestedPct, Math.max(0.5, pct / 2));
      messages.push({ level: 'warning', text: 'Your last 20 bets are at ' + (recent.roi * 100).toFixed(1) +
        '% ROI. Think about dropping to ' + suggestedPct + '% units until form recovers.' });
    } else if (graded.length >= 100 && summarize(graded).roi > 0.03 && pct < 2) {
      messages.push({ level: 'good', text: '100+ bets at a ' + (summarize(graded).roi * 100).toFixed(1) +
        '% ROI is a solid sample. You could move up to a 2% unit.' });
    } else if (graded.length < 50) {
      messages.push({ level: 'info', text: 'Only ' + graded.length + ' graded bet' + (graded.length === 1 ? '' : 's') +
        ' so far. Results are mostly noise until you have 100 or more. Keep units at 1–2%.' });
    }

    if (series.maxDrawdownPct >= 0.3) {
      messages.push({ level: 'warning', text: 'Your worst drawdown so far was ' + Math.round(series.maxDrawdownPct * 100) +
        '% from peak. If that felt too painful, a smaller unit will smooth the swings.' });
    }

    if (!messages.length) {
      messages.push({ level: 'good', text: 'Your unit size looks sensible for your bankroll and record.' });
    }

    return { suggestedPct, unit, current, messages };
  }

  /* ---------- CSV ---------- */

  const CSV_FIELDS = ['date', 'sport', 'event', 'type', 'selection', 'book', 'odds', 'stake', 'units', 'status', 'cashout', 'profit', 'notes'];

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(bets) {
    const rows = [CSV_FIELDS.join(',')];
    for (const b of bets.slice().sort(byDate)) {
      const row = Object.assign({}, b, { profit: round(betProfit(b), 2), odds: round(Number(b.odds), 4) });
      rows.push(CSV_FIELDS.map((f) => csvCell(row[f])).join(','));
    }
    return rows.join('\n');
  }

  return {
    STATUSES, RISK_PROFILES, CONFIDENCE_UNITS, CSV_FIELDS,
    americanToDecimal, decimalToAmerican, parseOdds, formatOdds, impliedProbability,
    betProfit, betUnitsProfit, isSettled, isGraded, byDate,
    summarize, groupSummary, bankrollSeries,
    unitSize, kellyFraction, recommendStake, unitAdvice,
    toCSV, round,
  };
});
