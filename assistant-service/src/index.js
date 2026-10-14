// Leveraged site assistant: AI answers grounded in the site's knowledge base, plus a
// central question log for review. Runs as a Cloudflare Worker (see README.md).
//
// Routes
//   POST /chat  { question, history?, page? } -> { id, answered, answer, steps, sources }
//   POST /log   { ...entry }                   -> 204 (the widget reports feedback here)
//   GET  /log   Authorization: Bearer <REVIEW_TOKEN> -> { entries: [...] }
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
  return json(env, { entries: [...byId.values()].filter((e) => e.question).sort((a, b) => (a.ts < b.ts ? -1 : 1)) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    if (url.pathname === "/chat" && request.method === "POST") return chat(request, env);
    if (url.pathname === "/log" && request.method === "GET") return listLog(request, env);
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
