# Bet-Trakt

A bet tracker that calculates your profit and loss and recommends how many units to bet.

It runs entirely in your browser. There is no server, no account and no build step, and your bets are saved in the browser's local storage.

## Getting started

Open `index.html` in a browser. You can also serve the folder:

```bash
npm start            # python3 -m http.server 8000, then open http://localhost:8000
```

The app starts empty. On first launch you land on **Settings**: enter your starting bankroll and pick a unit size (1–3% is typical).

## Use it on your phone (GitHub Pages)

The repo is a ready-to-serve static site, with a web app manifest, icons and an offline service worker.

1. On GitHub, open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**, pick the branch with this code and the **/ (root)** folder, then **Save**.
3. After a minute or two the site is live at `https://<your-username>.github.io/Bet-Trakt/`.
4. Open that link on your phone and add it to your home screen:
   - **iPhone (Safari):** tap **Share**, then **Add to Home Screen**.
   - **Android (Chrome):** tap **Install** in the app's banner, or open the **⋮** menu and choose **Add to Home screen** or **Install app**.

Opened from the home screen, it runs full screen like an app and works offline.

Your bets are saved on the device, in that browser's storage. On iPhone, the home-screen app keeps its own copy, separate from Safari, so pick one and stick with it. Use **Download backup** and **Restore backup** in Settings to move bets between devices.

### Phone and browser detection

On load (and whenever the window changes), the app sets two attributes on `<html>`:

| Attribute | Values | Effect |
|---|---|---|
| `data-device` | `phone` / `desktop` | Phones get a bottom tab bar, bet cards instead of a wide table, larger tap targets and 16px inputs (stops iOS zooming in) |
| `data-display` | `app` / `browser` | `app` means it was opened from the home screen or installed. In a phone browser, an "Add to home screen" banner shows steps for iPhone or Android, or an **Install** button where the browser supports it |

**Settings → This device** shows what was detected.

## Features

**Profit and loss**
- Profit/loss in dollars and units, ROI, win rate (W-L-P), current and longest streaks
- Bankroll chart over time with starting-bankroll reference line, peak and max drawdown
- Breakdown by sport, bet type or sportsbook (chart and table)
- Pending exposure, plus "to win" amounts on open bets
- Handles wins, losses, pushes, voids and cash-outs

**Unit recommendations**
- **Unit size** = bankroll × unit %. You choose whether it's based on your *current* bankroll (it shrinks after losses and grows after wins) or your *starting* bankroll (it stays fixed).
- **By confidence** (default): 1 = 0.5u, 2 = 1u, 3 = 1.5u, 4 = 2u, 5 = 3u.
- **By Kelly criterion**: enter your own win probability and the stake is
  `bankroll × kelly × multiplier`, where `kelly = (b·p − q) / b` and `b = decimal odds − 1`.
  Quarter Kelly is the default. If your probability is below the break-even implied by the odds, the app says **Pass**.
- Every recommendation is capped at your max bet and rounded to 0.25u.
- **Bankroll advice** flags oversized units, drawdowns while your unit is still based on the starting bankroll, cold streaks (last 20 bets below −10% ROI) and small sample sizes.

**Data**
- Export to CSV, plus JSON backup and restore (also how you move your data to another device)
- American or decimal odds
- Light and dark mode, works on phones

## How the numbers are calculated

| Metric | Formula |
|---|---|
| Profit (won) | stake × (decimal odds − 1) |
| Profit (lost) | −stake |
| Profit (cash-out) | cash-out amount − stake |
| Push / void / pending | 0 |
| ROI | total profit ÷ total staked on graded bets (voids excluded) |
| Win rate | wins ÷ (wins + losses); pushes excluded |
| Units won | each bet's profit converted to units at the unit size *when the bet was placed* |

## Publishing as a claude.ai artifact

```bash
npm run build:artifact   # writes dist/bet-trakt.html
```

The build inlines the CSS and JS into one page. When it runs as an artifact with the `db`, `user` and `downloads` capabilities, bets are saved to the viewer's private space in their Claude account and exports go through the artifact's save prompt. Anywhere else it falls back to browser storage and normal downloads.

## Project layout

```
index.html        UI markup
styles.css        Styles (light and dark)
js/calc.js        Pure betting math: odds, P&L, stats, unit sizing, Kelly, CSV
js/app.js         UI, storage, charts
sw.js             Service worker (offline support). Bump CACHE when you change files.
manifest.webmanifest, icons/   Home-screen app name and icons
tests/            Unit tests for js/calc.js
scripts/          build-artifact.js bundles the app into one HTML file
```

## Tests

```bash
npm test
```

Requires Node 18 or later. The tests use the built-in `node:test` runner, so there's nothing to install.

---

Stake recommendations are a bankroll-management aid, not betting advice. Only bet what you can afford to lose.
