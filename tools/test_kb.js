#!/usr/bin/env node
/* Checks the site assistant still gives the right answer to every question in
 * tools/kb-tests.json. Run after changing the knowledge base or assistant.js:
 *
 *   python3 tools/build_kb.py && node tools/test_kb.js
 *
 * Needs Playwright (npm install -g playwright, then npx playwright install chromium).
 * Each test is { "question": "...", "expect": "<entry id>" }, or "expect": null
 * when the assistant should say it doesn't know. To add a test, ask the question,
 * find the right entry's "id" in assistant/kb.json and add it to the list.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  await page.route('**/*', (route) => (route.request().url().startsWith('http://localhost') ? route.continue() : route.abort()));
  await page.goto(`http://localhost:${server.address().port}/index.html`);
  await page.waitForFunction(() => window.__levAssistantMatch && window.__levAssistantMatch('rates') !== undefined);

  const tests = JSON.parse(fs.readFileSync(path.join(__dirname, 'kb-tests.json'), 'utf8'));
  const ids = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'assistant/kb.json'), 'utf8')).entries.map((e) => e.id));
  let failed = 0;
  for (const t of tests) {
    const got = await page.evaluate((q) => window.__levAssistantMatch(q), t.question);
    const ok = got === t.expect;
    if (!ok) failed++;
    const note = t.expect && !ids.has(t.expect) ? ' (expected id no longer exists in kb.json)' : '';
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.question}${ok ? '' : `\n      expected ${t.expect}, got ${got}${note}`}`);
  }
  console.log(`\n${tests.length - failed} of ${tests.length} passed`);
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})();
