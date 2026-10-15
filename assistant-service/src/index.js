// Leveraged site assistant: AI answers grounded in the site's knowledge base, plus a
// central question log for review. Runs as a Cloudflare Worker (see README.md).
//
// Routes
//   POST /chat  { question, history?, page? } -> { id, answered, answer, steps, sources }
//   POST /log   { ...entry }                   -> 204 (the widget reports feedback here)
//   GET  /log   Authorization: Bearer <REVIEW_TOKEN> -> { entries: [...] }
//   GET  /review (+ /review.md, /review.csv)  password-protected review page (password = REVIEW_TOKEN)
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const KB_TTL_MS = 10 * 60 * 1000;
let kbCache = { at: 0, text: "", ids: new Set() };

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answered: {
      type: "boolean",
      description: "true only if the knowledge base fully supports the answer",
    },
    answer: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    sources: {
      type: "array",
      items: { type: "string" },
      description: "ids of the knowledge base entries used",
    },
  },
  required: ["answered", "answer", "steps", "sources"],
  additionalProperties: false,
};

const RULES = `You are the assistant on the Leveraged website. Leveraged Equities Limited is a margin lender and a subsidiary of Bendigo and Adelaide Bank. You help visitors find the right form, follow a process, and understand how Leveraged's products work.

Rules:
- Answer ONLY from the knowledge base below. If it does not clearly cover the question, set "answered" to false and give a short, polite answer pointing people to 1300 307 807 (Mon-Fri 8:30am-5:30pm AEST/AEDT). Do not guess, and do not use outside knowledge about Leveraged or other lenders.
- For new facilities, direct clients can call Young Ngai, Business Development Manager for direct clients, on 03 8633 1236. Financial advisers should use "Find your BDM" on the Adviser-only page.
- General information only. Never give personal financial advice or say whether a product suits someone. Suggest speaking with a financial adviser where relevant.
- Never ask for, repeat or store account numbers, SRN/HIN numbers, tax file numbers or other personal details.
- For processes and forms, put the steps in "steps" in order, naming the exact form and section. Keep "answer" to two or three short sentences in plain Australian English.
- Quote rates, fees and dates exactly as they appear in the knowledge base, including the "as at" date.
- List the ids of every knowledge base entry you relied on in "sources".`;

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });
}

// Strip anything that looks like an account, SRN/HIN, TFN, phone or email before logging.
function redact(s) {
  return String(s || "")
    .slice(0, 500)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\b[A-Za-z]?\d[\d\s-]{6,}\d\b/g, "[number]");
}

async function loadKb(env) {
  if (kbCache.text && Date.now() - kbCache.at < KB_TTL_MS) return kbCache;
  const res = await fetch(env.KB_URL, { cf: { cacheTtl: 600 } });
  if (!res.ok) throw new Error(`knowledge base fetch failed: ${res.status}`);
  const kb = await res.json();
  const ids = new Set();
  const lines = kb.entries.map((e) => {
    ids.add(e.id);
    const parts = [`[${e.id}] ${e.title} (${e.group})`, e.answer];
    if (e.steps?.length) parts.push("Steps: " + e.steps.map((s, i) => `${i + 1}. ${s}`).join(" "));
    if (e.notes?.length) parts.push("Notes: " + e.notes.join(" "));
    if (e.links?.length) parts.push("Links: " + e.links.map((l) => `${l.label} <${l.href}>`).join("; "));
    if (e.source) parts.push(`Source: ${e.source}`);
    return parts.join("\n");
  });
  kbCache = { at: Date.now(), text: lines.join("\n\n"), ids };
  return kbCache;
}

async function saveLog(env, entry) {
  if (!env.LOGS) return;
  const id = entry.id || `q${Date.now()}`;
  const key = `log:${entry.ts || new Date().toISOString()}:${id}`;
  await env.LOGS.put(key, JSON.stringify({ ...entry, id }), { expirationTtl: 60 * 60 * 24 * 365 });
}

async function chat(request, env) {
  // Without an API key the service is log-only: the widget falls back to
  // knowledge-base answers in the browser and still sends its log here.
  if (!env.ANTHROPIC_API_KEY) return json(env, { error: "ai disabled" }, 503);
  const body = await request.json().catch(() => ({}));
  const question = String(body.question || "").trim().slice(0, 500);
  if (!question) return json(env, { error: "question required" }, 400);

  const kb = await loadKb(env);
  const messages = [];
  for (const turn of (body.history || []).slice(-6)) {
    if (turn?.q && turn?.a) {
      messages.push({ role: "user", content: String(turn.q).slice(0, 500) });
      messages.push({ role: "assistant", content: String(turn.a).slice(0, 2000) });
    }
  }
  messages.push({ role: "user", content: question });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const id = `q${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  let result = { answered: false, answer: "", steps: [], sources: [] };

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: ANSWER_SCHEMA },
      },
      system: [
        { type: "text", text: RULES },
        {
          type: "text",
          text: `Knowledge base (site: ${env.SITE_URL}):\n\n${kb.text}`,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });

    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      result.answer = "I can't help with that here. Please call our team on 1300 307 807.";
    } else {
      const text = response.content.find((b) => b.type === "text")?.text || "{}";
      const parsed = JSON.parse(text);
      result = {
        answered: Boolean(parsed.answered),
        answer: String(parsed.answer || ""),
        steps: Array.isArray(parsed.steps) ? parsed.steps.map(String) : [],
        sources: (parsed.sources || []).filter((s) => kb.ids.has(s)),
      };
    }
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json(env, { error: "busy" }, 503);
    if (err instanceof Anthropic.APIError) return json(env, { error: `upstream ${err.status}` }, 502);
    throw err;
  }

  await saveLog(env, {
    id,
    ts: new Date().toISOString(),
    page: redact(body.page),
    question: redact(question),
    status: result.answered ? "answered" : "unanswered",
    matched: result.sources.join(",") || null,
    answer: result.answered ? result.answer.slice(0, 1000) : null,
  });
  return json(env, { id, ...result });
}

async function listLog(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.REVIEW_TOKEN || auth !== `Bearer ${env.REVIEW_TOKEN}`) return json(env, { error: "unauthorised" }, 401);
  return json(env, { entries: await getEntries(env) });
}

async function getEntries(env) {
  const entries = [];
  let cursor;
  do {
    const page = await env.LOGS.list({ prefix: "log:", cursor, limit: 1000 });
    for (const k of page.keys) {
      const v = await env.LOGS.get(k.name, "json");
      if (v) entries.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && entries.length < 5000);
  // Fold feedback records ({id, rating}) into the question they rate.
  const byId = new Map();
  for (const e of entries) {
    if (e.question) byId.set(e.id, { ...byId.get(e.id), ...e });
    else if (e.rating) byId.set(e.id, { ...byId.get(e.id), rating: e.rating });
  }
  return [...byId.values()].filter((e) => e.question).sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

// ---------- Review page (password protected) ----------
// The browser shows its own login box. Any username; the password is REVIEW_TOKEN.
function reviewAuthorised(request, env) {
  const m = (request.headers.get("Authorization") || "").match(/^Basic (.+)$/);
  if (!m || !env.REVIEW_TOKEN) return false;
  let decoded = "";
  try { decoded = atob(m[1]); } catch { return false; }
  return decoded.slice(decoded.indexOf(":") + 1) === env.REVIEW_TOKEN;
}

const PRIVATE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

function reviewStatus(e) {
  if (e.status === "unanswered") return "unanswered";
  if (e.rating === "not-helpful" || e.rating === "down") return "not helpful";
  if (e.rating === "helpful" || e.rating === "up") return "helpful";
  return "answered";
}

function pickEntries(entries, show) {
  const list = entries.filter((e) => {
    const st = reviewStatus(e);
    return show === "all" || (show === "unanswered" ? st === "unanswered" : st === "unanswered" || st === "not helpful");
  });
  return list.reverse();
}

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const mdCell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function review(request, env, url) {
  if (!reviewAuthorised(request, env)) {
    return new Response("Password required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Leveraged assistant review", charset="UTF-8"', ...PRIVATE },
    });
  }
  const entries = await getEntries(env);
  const show = ["all", "unanswered"].includes(url.searchParams.get("show")) ? url.searchParams.get("show") : "gaps";
  const list = pickEntries(entries, show);
  const stamp = new Date().toISOString().slice(0, 10);

  if (url.pathname === "/review.md") {
    const md = "| When | Question | Status | Matched answer | Page | Correct answer (to fill in) | Source |\n|---|---|---|---|---|---|---|\n" +
      list.map((e) => "| " + [(e.ts || "").slice(0, 16).replace("T", " "), e.question, reviewStatus(e), e.matched || "-", e.page, "", ""].map(mdCell).join(" | ") + " |").join("\n");
    return new Response(`# Assistant review\n\n${md}\n`, {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="assistant-review-${stamp}.md"`, ...PRIVATE },
    });
  }
  if (url.pathname === "/review.csv") {
    const csv = "when,question,status,matched,page\n" + list.map((e) => [e.ts, e.question, reviewStatus(e), e.matched, e.page].map(csvCell).join(",")).join("\n");
    return new Response(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="assistant-review-${stamp}.csv"`, ...PRIVATE },
    });
  }

  const count = (f) => entries.filter(f).length;
  const stats = [
    ["Questions asked", entries.length],
    ["Answered", count((e) => e.status === "answered")],
    ["Unanswered", count((e) => e.status === "unanswered")],
    ["Marked not helpful", count((e) => reviewStatus(e) === "not helpful")],
  ];
  const tab = (key, label) => `<a href="?show=${key}"${show === key ? ' aria-current="page"' : ""}>${label}</a>`;
  const rows = list.length
    ? list.map((e) => `<tr><td>${esc(e.ts ? new Date(e.ts).toLocaleString("en-AU", { timeZone: "Australia/Sydney" }) : "")}</td><td class="q">${esc(e.question)}</td><td><span class="tag">${esc(reviewStatus(e))}</span></td><td>${esc(e.matched || "-")}</td><td>${esc(e.page)}</td></tr>`).join("")
    : '<tr><td colspan="5" class="empty">Nothing to review.</td></tr>';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Assistant review – Leveraged</title>
<style>
body{margin:0;font-family:Manrope,"Segoe UI",system-ui,sans-serif;background:#F6F7F9;color:#0B1B2B}
header{background:#003F72;color:#fff;padding:32px 20px}header div,main{max-width:1100px;margin:0 auto}
h1{margin:0 0 6px;font-family:Georgia,serif;font-size:34px}header p{margin:0;color:#CFE0F2}
main{padding:28px 20px 60px;display:flex;flex-direction:column;gap:20px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{background:#fff;border:1px solid #DDE3EA;border-radius:12px;padding:14px 16px}.stat b{display:block;font-size:26px}.stat span{color:#55606C;font-size:14px}
.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.bar a{min-height:40px;display:inline-flex;align-items:center;padding:0 14px;border:2px solid #003F72;border-radius:8px;color:#003F72;font-weight:700;text-decoration:none}
.bar a[aria-current]{background:#003F72;color:#fff}.bar .dl{border-color:#C2410C;color:#C2410C}
.tw{overflow-x:auto;background:#fff;border:1px solid #DDE3EA;border-radius:12px}
table{border-collapse:collapse;width:100%;min-width:720px;font-size:15px}th,td{text-align:left;vertical-align:top;padding:12px 14px;border-bottom:1px solid #EEF1F4}
th{background:#F0F3F6;font-size:13px}td.q{font-weight:600}.tag{font-size:12px;font-weight:700;text-transform:uppercase;background:#FFF1E8;color:#9A3412;padding:4px 8px;border-radius:6px;white-space:nowrap}
.empty{text-align:center;color:#55606C;padding:28px}.howto{font-size:15px;line-height:1.6;color:#33404D}
</style></head><body>
<header><div><h1>Assistant review</h1><p>Questions visitors asked the site assistant. Private: this page needs the review password.</p></div></header>
<main>
<div class="stats">${stats.map(([l, n]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("")}</div>
<nav class="bar" aria-label="Filter">${tab("gaps", "Needs attention")}${tab("unanswered", "Unanswered only")}${tab("all", "All questions")}
<a class="dl" href="/review.md?show=${show}">Download .md</a><a class="dl" href="/review.csv?show=${show}">Download .csv</a></nav>
<div class="tw"><table><thead><tr><th>When (Sydney)</th><th>Question</th><th>Status</th><th>Matched answer</th><th>Page</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="howto"><strong>To close a gap:</strong> download the .md file, confirm each answer against the PDS, form or policy, add it to <code>tools/kb-curated.json</code>, run <code>python3 tools/build_kb.py</code> and push.</div>
</main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...PRIVATE } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    if (url.pathname === "/chat" && request.method === "POST") return chat(request, env);
    if (url.pathname === "/log" && request.method === "GET") return listLog(request, env);
    if (["/review", "/review.md", "/review.csv"].includes(url.pathname) && request.method === "GET") return review(request, env, url);
    if (url.pathname === "/log" && request.method === "POST") {
      const e = await request.json().catch(() => null);
      if (e && (e.question || e.rating)) {
        await saveLog(env, {
          id: String(e.id || ""),
          ts: e.ts || new Date().toISOString(),
          question: e.question ? redact(e.question) : undefined,
          status: e.status,
          rating: e.rating,
          matched: e.matched,
          page: redact(e.page),
        });
      }
      return new Response(null, { status: 204, headers: cors(env) });
    }
    return json(env, { error: "not found" }, 404);
  },
};
