/* Leveraged site assistant.
 * Answers questions from assistant/kb.json (built by tools/build_kb.py).
 * If assistant/config.json sets an "endpoint", questions go to the AI service in
 * /assistant-service instead, falling back to the local knowledge base if it is unavailable.
 * Unanswered questions and feedback are logged for review on the assistant service (https://leveraged-assistant.leveraged.workers.dev/review, password protected).
 */
(function () {
  'use strict';
  if (window.__levAssistant) return;
  window.__levAssistant = true;

  var script = document.currentScript || document.querySelector('script[src$="assistant/assistant.js"]');
  var ROOT = script.getAttribute('src').replace(/assistant\/assistant\.js(\?.*)?$/, '');
  var LOG_KEY = 'levAssistantLog';
  var kb = null, config = { endpoint: '' }, history = [];

  var STOP = 'a an the and or of to in on for my i me is are do does how can what when where which who with it its be by from at as we you your our this that there if am was will would should could please about into have has get'.split(' ');
  var SYN = {
    srn: 'issuer sponsored', 'issuer-sponsored': 'issuer sponsored', hin: 'broker sponsored chess',
    shares: 'shares equities securities', equities: 'shares securities', transfer: 'transfer lodge move',
    lodge: 'lodge transfer', move: 'transfer move', withdraw: 'withdraw release transfer',
    lvr: 'lending ratio lvr', 'credit limit': 'credit limit', bdm: 'business development manager',
    apply: 'apply application', rate: 'rate rates interest', cost: 'rate fees', fee: 'fees fee',
    address: 'address contact details', password: 'password login leveraged online', login: 'login password online',
    bank: 'bank account', dividends: 'dividends distributions', tfn: 'tax file number', close: 'close closure'
  };

  function tokens(s) {
    s = (s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9$%.\- ]+/g, ' ');
    var extra = [];
    Object.keys(SYN).forEach(function (k) { if (s.indexOf(k) > -1) extra.push(SYN[k]); });
    return (s + ' ' + extra.join(' ')).split(/\s+/).filter(function (t) {
      t = t.replace(/^[.\-]+|[.\-]+$/g, '');
      return t.length > 1 && STOP.indexOf(t) < 0;
    }).map(function (t) { return t.replace(/^[.\-]+|[.\-]+$/g, '').replace(/s$/, ''); });
  }

  function prepare(data) {
    var df = {};
    data.entries.forEach(function (e) {
      e._t = tokens(e.title);
      e._k = tokens((e.keywords || []).join(' '));
      e._a = tokens(e.answer + ' ' + (e.steps || []).join(' ') + ' ' + e.group);
      var seen = {};
      e._t.concat(e._k, e._a).forEach(function (t) { if (!seen[t]) { seen[t] = 1; df[t] = (df[t] || 0) + 1; } });
    });
    data.idf = {};
    var n = data.entries.length;
    Object.keys(df).forEach(function (t) { data.idf[t] = Math.log(1 + n / df[t]); });
    return data;
  }

  function search(q) {
    var qt = tokens(q), uniq = {};
    qt.forEach(function (t) { uniq[t] = 1; });
    qt = Object.keys(uniq);
    var ranked = kb.entries.map(function (e) {
      var s = 0, hits = 0;
      qt.forEach(function (t) {
        var w = kb.idf[t] || 0, h = 0;
        if (e._k.indexOf(t) > -1) h += 3;
        if (e._t.indexOf(t) > -1) h += 2.5;
        if (e._a.indexOf(t) > -1) h += 1;
        if (h) hits++;
        s += w * h;
      });
      var coverage = qt.length ? hits / qt.length : 0;
      // An entry whose title is the question itself beats one that just shares its words.
      var exact = qt.length && e._t.length === qt.length && qt.every(function (t) { return e._t.indexOf(t) > -1; });
      return { e: e, score: s * (0.5 + coverage) * (exact ? 1.5 : 1), coverage: coverage };
    }).sort(function (a, b) { return b.score - a.score; });
    return { query: qt, ranked: ranked };
  }

  /* ---------- logging ---------- */
  // Questions are never kept in the visitor's browser; they go only to the
  // assistant service (when configured), so a visitor can't read them back.
  try { localStorage.removeItem(LOG_KEY); } catch (e) {}
  function send(body) {
    if (!config.endpoint) return;
    try {
      fetch(config.endpoint.replace(/\/$/, '') + '/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true });
    } catch (e) {}
  }
  function log(entry) {
    entry.ts = new Date().toISOString();
    entry.page = location.pathname.replace(/^.*?leveraged-redesign/, '') || '/';
    var serverLogged = entry.serverLogged; delete entry.serverLogged;
    if (!serverLogged) send(entry);
    return entry;
  }
  function rate(id, value) {
    send({ id: id, rating: value, ts: new Date().toISOString() });
  }

  /* ---------- UI ---------- */
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function href(h) { return /^(https?:|mailto:|tel:|#)/.test(h) ? h : ROOT + h; }

  var css = el('link', { rel: 'stylesheet', href: ROOT + 'assistant/assistant.css' });
  document.head.appendChild(css);

  var btn = el('button', { type: 'button', class: 'lva-launch', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'lva-panel' },
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="currentColor"/></svg><span>Ask a question</span>');
  var panel = el('section', { id: 'lva-panel', class: 'lva-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'lva-title', hidden: '' },
    '<header class="lva-head"><div><h2 id="lva-title">Leveraged assistant</h2><p>Help with forms, FAQs and getting started</p></div>' +
    '<button type="button" class="lva-x" aria-label="Close assistant">×</button></header>' +
    '<div class="lva-log" role="log" aria-live="polite"></div>' +
    '<div class="lva-chips" aria-label="Suggested questions"></div>' +
    '<form class="lva-form"><label for="lva-q" class="lva-sr">Your question</label>' +
    '<input id="lva-q" type="text" autocomplete="off" maxlength="300" placeholder="e.g. How do I transfer my SRN shares?">' +
    '<button type="submit" aria-label="Send">→</button></form>' +
    '<p class="lva-fine">General information only, not personal advice. Please don’t enter account numbers, SRN/HIN numbers or personal details.</p>');
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var logEl = panel.querySelector('.lva-log'), input = panel.querySelector('#lva-q'), chipsEl = panel.querySelector('.lva-chips');
  var CHIPS = ['How do I transfer my SRN shares to my margin loan?', 'How do I increase my credit limit?', 'What are your current rates?', 'How do I apply?', 'Who can I talk to?'];
  CHIPS.forEach(function (c) {
    var b = el('button', { type: 'button' }, esc(c));
    b.addEventListener('click', function () { ask(c); });
    chipsEl.appendChild(b);
  });

  function say(html, who) {
    var m = el('div', { class: 'lva-msg lva-' + who }, html);
    logEl.appendChild(m);
    logEl.scrollTop = who === 'bot' ? Math.max(0, m.offsetTop - logEl.offsetTop - 12) : logEl.scrollHeight;
    return m;
  }

  function renderEntry(e) {
    var h = '<p class="lva-q-title">' + esc(e.title) + '</p><p>' + esc(e.answer).replace(/\n+/g, '</p><p>') + '</p>';
    if (e.steps && e.steps.length) h += '<ol>' + e.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    if (e.notes && e.notes.length) h += '<ul class="lva-notes">' + e.notes.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
    if (e.links && e.links.length) h += '<div class="lva-links">' + e.links.slice(0, 5).map(function (l) {
      var ext = /^https?:/.test(l.href) && l.href.indexOf('leveraged.com.au') < 0 || /\.pdf$/i.test(l.href);
      return '<a href="' + esc(href(l.href)) + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + esc(l.label) + '</a>';
    }).join('') + '</div>';
    if (e.source) h += '<p class="lva-src">Source: ' + esc(e.source) + '</p>';
    return h;
  }

  function feedback(msg, id) {
    var f = el('div', { class: 'lva-fb' }, '<span>Was this helpful?</span><button type="button" data-v="yes">Yes</button><button type="button" data-v="no">No</button>');
    f.addEventListener('click', function (ev) {
      var v = ev.target.getAttribute('data-v'); if (!v) return;
      rate(id, v === 'yes' ? 'helpful' : 'not-helpful');
      f.innerHTML = v === 'yes' ? '<span>Thanks for letting us know.</span>'
        : '<span>Sorry about that. We’ve noted it so we can improve. You can also call <a href="tel:1300307807">1300 307 807</a>.</span>';
    });
    msg.appendChild(f);
  }

  function unknown(q, serverId) {
    var entry = log({ id: serverId || 'q' + Date.now(), question: q, status: 'unanswered', matched: null, serverLogged: !!serverId });
    var m = say('<p>I don’t have a confident answer to that yet. I’ve passed your question on so our team can add it.</p>' +
      '<p>For now, our team can help:</p><div class="lva-links">' +
      '<a href="tel:1300307807">Call 1300 307 807</a>' +
      '<a href="tel:+61386331236">New facility? Call Young 03 8633 1236</a>' +
      '<a href="' + ROOT + 'contact-us/enquiry/index.html">Send an enquiry</a>' +
      '<a href="' + ROOT + 'support/faqs/index.html">Browse FAQs</a></div>', 'bot');
    return entry;
  }

  // The confident match for a question, or null if there isn't one.
  function bestMatch(r) {
    var top = r.ranked[0];
    return (!r.query.length || !top || top.score < 4 || top.coverage < 0.34) ? null : top;
  }
  // Used by tools/test_kb.js to check which entry each test question gets.
  window.__levAssistantMatch = function (q) { if (!kb) return undefined; var m = bestMatch(search(q)); return m ? m.e.id : null; };

  function answerLocal(q) {
    var r = search(q), top = bestMatch(r);
    if (!top) return unknown(q);
    var entry = log({ id: 'q' + Date.now(), question: q, status: 'answered', matched: top.e.id, score: Math.round(top.score * 10) / 10 });
    var m = say(renderEntry(top.e), 'bot');
    var related = r.ranked.slice(1, 4).filter(function (x) { return x.score > top.score * 0.6 && x.score >= 4; });
    if (related.length) {
      var rel = el('div', { class: 'lva-related' }, '<span>Related:</span>');
      related.forEach(function (x) {
        var b = el('button', { type: 'button' }, esc(x.e.title));
        b.addEventListener('click', function () { ask(x.e.title); });
        rel.appendChild(b);
      });
      m.appendChild(rel);
    }
    feedback(m, entry.id);
  }

  function answerRemote(q) {
    var thinking = say('<p class="lva-typing">Thinking…</p>', 'bot');
    return fetch(config.endpoint.replace(/\/$/, '') + '/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, history: history.slice(-6), page: location.pathname })
    }).then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
      .then(function (d) {
        thinking.remove();
        history.push({ q: q, a: d.answer });
        if (!d.answered) return unknown(q, d.id);
        var entry = log({ id: d.id || 'q' + Date.now(), question: q, status: 'answered', matched: (d.sources || []).join(',') || 'ai', serverLogged: !!d.id });
        var links = [];
        (d.sources || []).forEach(function (id) {
          var e = kb.entries.filter(function (x) { return x.id === id; })[0];
          if (e && e.links) links = links.concat(e.links);
        });
        var m = say(renderEntry({ title: q, answer: d.answer, steps: d.steps, links: links.slice(0, 5), source: 'Leveraged assistant (AI). Check the linked documents before acting.' }), 'bot');
        feedback(m, entry.id);
      })
      .catch(function () { thinking.remove(); answerLocal(q); });
  }

  function ask(q) {
    q = (q || '').trim();
    if (!q) return;
    if (chipsEl) chipsEl.hidden = true;
    say('<p>' + esc(q) + '</p>', 'user');
    if (/\b\d{8,}\b|\bx?\d{10,11}\b|@.+\./.test(q)) {
      say('<p>For your security, please don’t share account numbers, SRN/HIN numbers or email addresses here. Ask your question without them, or call 1300 307 807.</p>', 'bot');
      return;
    }
    if (config.endpoint) answerRemote(q); else answerLocal(q);
  }

  function open() {
    panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); btn.classList.add('lva-open');
    if (!logEl.childNodes.length) say('<p>Hi, I can help you find the right form, explain how something works, or point you to the right person. What would you like to know?</p>', 'bot');
    setTimeout(function () { input.focus(); }, 30);
  }
  function close() { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('lva-open'); btn.focus(); }

  btn.addEventListener('click', function () { panel.hidden ? open() : close(); });
  panel.querySelector('.lva-x').addEventListener('click', close);
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  panel.querySelector('.lva-form').addEventListener('submit', function (e) { e.preventDefault(); var q = input.value; input.value = ''; ask(q); });

  Promise.all([
    fetch(ROOT + 'assistant/kb.json').then(function (r) { return r.json(); }),
    fetch(ROOT + 'assistant/config.json').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
  ]).then(function (res) { kb = prepare(res[0]); config = Object.assign(config, res[1] || {}); })
    .catch(function () { btn.hidden = true; });

  window.LevAssistant = { ask: function (q) { open(); ask(q); }, search: function (q) { return kb && search(q).ranked.slice(0, 3); } };
})();
