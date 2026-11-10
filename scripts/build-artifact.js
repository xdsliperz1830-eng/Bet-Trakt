#!/usr/bin/env node
/*
 * Bundle the app into one self-contained HTML file for publishing as a
 * claude.ai artifact. The artifact host adds its own <html>/<head>/<body>
 * skeleton, so the output starts with <title> and inlines the CSS and JS.
 *
 *   node scripts/build-artifact.js [out-file]   (default: dist/bet-trakt.html)
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const out = path.resolve(process.argv[2] || path.join(root, 'dist', 'bet-trakt.html'));

const html = read('index.html');
const body = html.match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/\s*<script src="[^"]+"><\/script>/g, '')
  .trim();
const description = (html.match(/<meta name="description" content="([^"]*)">/) || [])[1] || '';
const inlineScript = (f) => {
  const js = read(f);
  if (/<\/script/i.test(js)) throw new Error(f + ' contains </script>');
  return '<script>\n' + js + '\n</script>';
};

const page = [
  '<title>Bet-Trakt</title>',
  '<meta name="description" content="' + description + '">',
  '<meta name="claude:viewport-fit-sides" content="cover">',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap">',
  '<style>\n' + read('styles.css') + '\n</style>',
  body,
  inlineScript('js/calc.js'),
  inlineScript('js/parse.js'),
  inlineScript('js/app.js'),
].join('\n') + '\n';

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log('Wrote ' + path.relative(process.cwd(), out) + ' (' + (page.length / 1024).toFixed(1) + ' KB)');
