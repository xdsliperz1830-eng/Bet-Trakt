/*
 * Bet-Trakt quick add: turn typed text, or text read from a bet-slip
 * screenshot, into draft bets. Pure functions (no DOM), shared by the
 * browser (window.BetParse) and the Node tests.
 *
 *   parseBets("$25 on Chiefs ML -110 at FanDuel, won")
 *   -> [{ format: 'Single', event: 'Chiefs ML', odds: 1.909, stake: 25, book: 'FanDuel', status: 'won', ... }]
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BetParse = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BOOKS = [
    { name: 'FanDuel', re: /\bfan\s?duel\b|\bfd\b/i },
    { name: 'DraftKings', re: /\bdraft\s?kings\b|\bdk\b/i },
    { name: 'Sleeper', re: /\bsleeper\b/i },
    { name: 'Chalkboard', re: /\bchalk\s?board\b/i },
    { name: 'Fliff', re: /\bfliff\b/i },
  ];

  const NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
  const toNum = (s) => Number(String(s).replace(/,/g, ''));

  function americanToDecimal(a) {
    return a >= 100 ? 1 + a / 100 : a <= -100 ? 1 + 100 / Math.abs(a) : NaN;
  }

  function round(n, p) {
    const f = Math.pow(10, p);
    return Math.round(n * f) / f;
  }

  function normalize(text) {
    return String(text || '')
      .replace(/[−‒–—]/g, '-') // minus signs and dashes
      .replace(/＋/g, '+')
      .replace(/[ \t]+/g, ' ')
      .replace(/\r/g, '');
  }

  function isoDate(d) {
    const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return z.toISOString().slice(0, 10);
  }

  /* ---------- single chunk → one draft bet ---------- */

  function parseOne(chunk, opts) {
    const o = opts || {};
    const today = o.today ? new Date(o.today + 'T12:00:00') : new Date();
    let s = normalize(chunk);
    const lower = s.toLowerCase();
    const warnings = [];
    const cut = []; // regexes of text to drop when building the description

    // Sportsbook
    let book = null;
    for (const b of BOOKS) if (b.re.test(s)) { book = b.name; cut.push(b.re); break; }

    // Money amounts with their roles
    let stake = null, toWin = null, payout = null, cashout = null, unitsStake = null;
    const grab = (re) => { const m = s.match(re); return m ? toNum(m[1]) : null; };

    cashout = grab(new RegExp('cash(?:ed)?\\s*-?\\s*out\\s*(?:for|at|of|:)?\\s*\\$?\\s*' + NUM, 'i'));
    toWin = grab(new RegExp('(?:to\\s*win|potential\\s*win(?:nings)?|win\\s*amount|profit)\\s*:?\\s*\\$?\\s*' + NUM, 'i'));
    payout = grab(new RegExp('(?:payout|pays|to\\s*pay|total\\s*return|returns?|collect)\\s*:?\\s*\\$?\\s*' + NUM, 'i'));
    stake = grab(new RegExp('(?:wager|stake|risk(?:ed)?|bet\\s*amount|amount)\\s*:?\\s*\\$?\\s*' + NUM, 'i'));
    unitsStake = grab(/(\d+(?:\.\d+)?)\s*(?:u|units?)\b/i);

    // Any other dollar amount is the stake (first one not already used for another role)
    const roleRe = new RegExp('(cash(?:ed)?\\s*-?\\s*out\\s*(?:for|at|of|:)?|to\\s*win|potential\\s*win(?:nings)?|win\\s*amount|profit|payout|pays|to\\s*pay|total\\s*return|returns?|collect)\\s*:?\\s*$', 'i');
    if (stake == null) {
      const moneyRe = new RegExp('\\$\\s?' + NUM + '|' + NUM + '\\s*(?:dollars|bucks|usd)\\b', 'gi');
      let m;
      while ((m = moneyRe.exec(s))) {
        const before = s.slice(Math.max(0, m.index - 24), m.index);
        if (roleRe.test(before)) continue;
        stake = toNum(m[1] || m[2]);
        break;
      }
    }
    cut.push(new RegExp('(cash(?:ed)?\\s*-?\\s*out|to\\s*win|potential\\s*win(?:nings)?|win\\s*amount|profit|payout|pays|to\\s*pay|total\\s*return|returns?|collect|wager|stake|risk(?:ed)?|bet\\s*amount|amount)\\s*(?:for|at|of)?\\s*:?\\s*\\$?\\s*' + NUM, 'gi'));
    cut.push(new RegExp('\\$\\s?' + NUM, 'g'), new RegExp(NUM + '\\s*(?:dollars|bucks|usd)\\b', 'gi'), /\b\d+(?:\.\d+)?\s*(?:u|units?)\b/gi);

    // Format and legs
    let legs = null;
    const legM = lower.match(/\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*-?\s*(?:leg|pick|team|way|fold)s?\b/);
    if (legM) legs = NUMBER_WORDS[legM[1]] || Number(legM[1]);
    let format = 'Single';
    if (legs >= 2 || /\b(parlay|sgp|same\s*game|multi|accumulator|acca)\b/i.test(s)) format = 'Parlay';
    if (/\b(single|straight)\b/i.test(s) && !legs) format = 'Single';
    if (format === 'Single') legs = null;
    cut.push(/\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*-?\s*(?:leg|pick|team|way|fold)s?\b/gi,
      /\b(parlay|sgp|same\s*game|multi|accumulator|acca|single|straight)\b/gi);

    // Odds
    let odds = null;
    const oddsTokens = [];
    const amRe = /(^|[^\w$.,])([+-])\s?(\d{3,5})(?!\d|[.,]\d)/g;
    let am;
    while ((am = amRe.exec(s))) {
      const v = Number(am[2] + am[3]);
      if (Math.abs(v) >= 100) oddsTokens.push({ dec: americanToDecimal(v), index: am.index });
    }
    const wordOdds = lower.match(/\b(plus|minus)\s*(\d{3,5})\b/);
    if (wordOdds) oddsTokens.push({ dec: americanToDecimal((wordOdds[1] === 'minus' ? -1 : 1) * Number(wordOdds[2])), index: 0 });
    if (oddsTokens.length) {
      // A parlay's total odds are bigger than any single leg's
      odds = format === 'Parlay' ? Math.max.apply(null, oddsTokens.map((t) => t.dec)) : oddsTokens[0].dec;
    } else {
      const dec = lower.match(/(?:odds|@|\bat)\s*:?\s*(\d{1,2}\.\d{1,3})\b/);
      const bare = lower.match(/(?:odds|@|\bat)\s*:?\s*(\d{3,5})\b/);
      if (dec && Number(dec[1]) > 1) odds = Number(dec[1]);
      else if (bare) {
        const dog = /\b(dog|underdog|plus)\b/.test(lower);
        odds = americanToDecimal((dog ? 1 : -1) * Number(bare[1]));
        warnings.push('No + or − on the odds, so ' + (dog ? '+' : '−') + bare[1] + ' was assumed. Check it.');
      }
    }
    cut.push(/(^|[^\w$.,])[+-]\s?\d{3,5}(?!\d|[.,]\d)/g, /\b(plus|minus)\s*\d{3,5}\b/gi, /(?:odds|@|\bat)\s*:?\s*\d{1,2}\.\d{1,3}\b/gi, /(?:odds|@)\s*:?\s*\d{3,5}\b/gi);

    // What the book pays is the most reliable price (it includes boosts)
    if (stake > 0 && toWin > 0) odds = 1 + toWin / stake;
    else if (stake > 0 && payout > stake) odds = payout / stake;
    if (!(stake > 0) && odds > 1 && toWin > 0) stake = round(toWin / (odds - 1), 2);
    if (!(stake > 0) && odds > 1 && payout > 0) stake = round(payout / odds, 2);

    // Result
    let status = 'pending';
    const st = lower.replace(/to\s*win|potential\s*win(nings)?|win\s*amount|to\s*pay/g, ' ');
    if (cashout != null || /\bcash(ed)?\s*-?\s*out\b/.test(st)) status = 'cashout';
    else if (/\b(void|voided|cancel+ed|refunded|no action)\b/.test(st)) status = 'void';
    else if (/\b(push|pushed|tie)\b/.test(st)) status = 'push';
    else if (/\b(won|win|winner|hit|cashed|w)\b/.test(st)) status = 'won';
    else if (/\b(lost|loss|lose|miss|missed|l)\b/.test(st)) status = 'lost';
    if (status === 'cashout' && cashout == null) { warnings.push('Cashed out, but no amount was found.'); }
    cut.push(/\b(void|voided|cancel+ed|refunded|no action|push|pushed|tie|won|win|winner|hit|cashed|lost|loss|lose|missed|miss|pending|open|settled)\b/gi,
      /(^|\s)[wl](?=\s|$|[,.!])/gi);

    // Date
    let date = null;
    if (/\byesterday\b|\blast night\b/.test(lower)) { const d = new Date(today); d.setDate(d.getDate() - 1); date = isoDate(d); }
    else if (/\btoday\b|\btonight\b/.test(lower)) date = isoDate(today);
    const md = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    const mn = lower.match(new RegExp('\\b(' + MONTHS.join('|') + ')[a-z]*\\.?\\s+(\\d{1,2})\\b'));
    if (md) {
      const y = md[3] ? (md[3].length === 2 ? 2000 + Number(md[3]) : Number(md[3])) : today.getFullYear();
      date = isoDate(new Date(y, Number(md[1]) - 1, Number(md[2]), 12));
    } else if (mn) {
      date = isoDate(new Date(today.getFullYear(), MONTHS.indexOf(mn[1].slice(0, 3)), Number(mn[2]), 12));
    }
    cut.push(/\b(yesterday|last night|today|tonight)\b/gi, /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
      new RegExp('\\b(' + MONTHS.join('|') + ')[a-z]*\\.?\\s+\\d{1,2}\\b', 'gi'));

    // Description: what's left once the recognised bits are removed
    let desc = s;
    for (const re of cut) desc = desc.replace(re, ' ');
    desc = desc
      .replace(/\b(i|i've|ive|i'm|im|bet|bets|betting|put|placed|place|took|take|on|at|for|with|my|a|an|the|was|it|and|odds|of|in|to|via|using|got|just|units?)\b/gi, ' ')
      .replace(/[,;:|•·()\[\]]+/g, ' ')
      .replace(/\s+-\s+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[-–.,\s]+|[-–.,\s]+$/g, '');
    if (desc.length > 60) desc = desc.slice(0, 57).trim() + '…';

    if (!(odds > 1)) warnings.push('Odds not found.');
    if (!(stake > 0) && !(unitsStake > 0)) warnings.push('Stake not found.');

    return {
      format,
      legs,
      event: desc,
      book,
      odds: odds > 1 ? round(odds, 4) : null,
      stake: stake > 0 ? round(stake, 2) : null,
      units: !(stake > 0) && unitsStake > 0 ? unitsStake : null,
      status,
      cashout: status === 'cashout' ? cashout : null,
      date,
      warnings,
    };
  }

  /* ---------- whole text → one or more drafts ---------- */

  const HAS_ODDS = /(^|[^\w$.,])[+-]\s?\d{3,5}(?!\d|[.,]\d)|\b(plus|minus)\s*\d{3,5}\b|(?:odds|@)\s*:?\s*\d/i;
  const HAS_MONEY = /\$\s?\d|\d\s*(dollars|bucks|usd)\b|\b\d+(\.\d+)?\s*(u|units?)\b|\b(wager|stake|risk)\b/i;

  /**
   * Typed text: one bet per line (or per ";"), when each line looks like a bet;
   * otherwise the whole text is one bet.
   */
  function parseBets(text, opts) {
    const lines = normalize(text).split(/\n|;/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const betLines = lines.filter((l) => HAS_ODDS.test(l) || HAS_MONEY.test(l));
    if (betLines.length >= 2 && betLines.length === lines.length) return lines.map((l) => parseOne(l, opts));
    return [parseOne(lines.join(' '), opts)];
  }

  /**
   * Text read from a bet-slip screenshot: usually one bet spread over many
   * lines. Several "Wager" lines mean several bets; each block runs to the
   * line after its wager (where "to win"/"payout" usually sits).
   */
  function parseSlip(text, opts) {
    const lines = normalize(text).split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const wagerIdx = lines.map((l, i) => (/\b(wager|stake|risk|bet amount)\b/i.test(l) ? i : -1)).filter((i) => i >= 0);
    const blocks = [];
    if (wagerIdx.length >= 2) {
      let start = 0;
      wagerIdx.forEach((w, k) => {
        const end = k === wagerIdx.length - 1 ? lines.length - 1 : w + 1;
        blocks.push(lines.slice(start, end + 1));
        start = end + 1;
      });
    } else {
      blocks.push(lines);
    }
    return blocks.map((blk) => {
      const bet = parseOne(blk.join('\n'), opts);
      // Leg names: lines that carry their own American odds
      const legNames = [];
      for (const l of blk) {
        if (!/[+-]\s?\d{3,5}(?!\d|[.,]\d)/.test(l) || !/[a-z]{3}/i.test(l)) continue;
        if (/\b(parlay|wager|stake|payout|to win|odds)\b/i.test(l)) continue;
        const name = l.replace(/[+-]\s?\d{3,5}(?!\d|[.,]\d)/g, ' ').replace(/[^\w.'&/ +-]/g, ' ').replace(/\s+/g, ' ').trim();
        if (name && !legNames.includes(name)) legNames.push(name);
      }
      if (legNames.length) {
        bet.event = legNames.slice(0, 4).join(' / ') + (legNames.length > 4 ? ' / …' : '');
        if (bet.format === 'Parlay' && !bet.legs && legNames.length >= 2) bet.legs = legNames.length;
      } else if (bet.event.length > 40) {
        bet.event = ''; // screenshot leftovers are rarely a useful name
      }
      return bet;
    });
  }

  return { parseBets, parseSlip, parseOne, BOOKS: BOOKS.map((b) => b.name) };
});
