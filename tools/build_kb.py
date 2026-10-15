#!/usr/bin/env python3
"""Build assistant/kb.json, the knowledge base used by the site assistant.

Sources (re-run this script whenever any of them change):
  - tools/kb-curated.json   hand-written guided answers (each cites its source)
  - support/faqs/index.html every FAQ question and answer
  - forms.html              every form, list and document with its download links
  - the site's content pages (PAGES below), one entry per section heading

Usage:  python3 tools/build_kb.py
"""
import html
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def text(fragment):
    fragment = re.sub(r"<br\s*/?>", "\n", fragment)
    fragment = re.sub(r"</(p|li|h\d)>", "\n", fragment)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    return re.sub(r"[ \t]+", " ", html.unescape(fragment)).strip()


def links(fragment, base_dir):
    out = []
    for href, label in re.findall(r'<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', fragment, re.S):
        if not re.match(r"(https?:|mailto:|tel:|#)", href):
            href = os.path.normpath(os.path.join(base_dir, href.split("#")[0])) + ("#" + href.split("#")[1] if "#" in href else "")
        out.append({"label": text(label), "href": href})
    return out


def faqs():
    path = os.path.join(ROOT, "support/faqs/index.html")
    s = open(path, encoding="utf-8").read()
    entries, seen = [], set()
    for sec in re.finditer(r'<section[^>]*>\s*<h2[^>]*>([^<]+)</h2>(.*?)</section>', s, re.S):
        group = text(sec.group(1))
        for q, a in re.findall(r'<details[^>]*><summary>(.*?)</summary>(.*?)</details>', sec.group(2), re.S):
            q = text(q)
            if q in seen:
                continue
            seen.add(q)
            entries.append({
                "id": "faq-" + re.sub(r"[^a-z0-9]+", "-", q.lower()).strip("-")[:60],
                "title": q, "group": "FAQ: " + group,
                "answer": text(a), "links": links(a, "support/faqs"),
                "source": "Support FAQs",
            })
    return entries


def forms():
    s = open(os.path.join(ROOT, "forms.html"), encoding="utf-8").read()
    entries = []
    for li in re.findall(r'<li class="doc[^"]*".*?</li>', s, re.S):
        title = text(re.search(r'<strong>(.*?)</strong>', li).group(1))
        desc = text(re.search(r'<div class="doc-main"><strong>.*?</strong><span>(.*?)</span>', li, re.S).group(1))
        dls = []
        for prods, href, label in re.findall(r'<div class="dl-row" data-products="([^"]+)">.*?<a class="dl" href="([^"]+)"[^>]*>([^<]+)</a>', li, re.S):
            prods = prods.split("|")
            who = "All products" if len(prods) == 3 else " / ".join(prods)
            dls.append({"label": f"{title} – {who}" if len(re.findall('dl-row', li)) > 1 else title, "href": html.unescape(href)})
        entries.append({
            "id": "form-" + re.sub(r"[^a-z0-9]+", "-", (title + "-" + dls[0]["href"][-20:]).lower()).strip("-")[:70],
            "title": title, "group": "Forms and documents",
            "answer": desc + ". Download it from the forms page or the link below.",
            "links": dls + [{"label": "All forms", "href": "forms.html"}],
            "source": "Forms and documents page",
        })
    return entries


# Content pages indexed section by section. News, adviser articles and old
# revised-agreement notices are left out: they're dated or not for customers.
PAGES = [
    "products", "products/margin-loan", "products/investment-funds-multiplier", "products/direct-investment-loan",
    "products/instalment-plus", "products/exchange-options-plus", "products/rewards-plus-qantas",
    "fees", "rates", "wholesale", "security", "transition-to-leveraged", "important-notices/upcoming-changes",
    "support/deceased-estates", "support/financial-abuse", "support/financial-abuse/types-of-financial-abuse",
    "support/financial-abuse/additional-assistance", "support/guides",
    "contact-us", "contact-us/customer-advocate", "contact-us/make-a-complaint",
    "contact-us/make-a-complaint/frequently-asked-questions", "policies/privacy-policy",
    "calculations.html", "product-comparison.html",
    "educational-insights/What-is-a-margin-lending-facility", "educational-insights/calculating-the-buffer",
    "educational-insights/fix-and-prepay-interest", "educational-insights/managing-volatility-and-your-margin-loan",
    "educational-insights/gear-into-international-shares", "educational-insights/boost-your-investment-capacity",
    "educational-insights/negative-gearing-is-changing-but-not-for-margin-lending",
]
SKIP_HEADINGS = {"try it with your numbers", "things you should know", "talk to a specialist", "talk to us", "related articles", "get in touch",
                 "get help from the right person", "need help?", "need a copy sent to you?"}
MAX_ANSWER = 700


def page_sections(rel):
    path = os.path.join(ROOT, rel if rel.endswith(".html") else rel + "/index.html")
    s = open(path, encoding="utf-8").read()
    base_dir = os.path.dirname(rel) if rel.endswith(".html") else rel
    href = rel if rel.endswith(".html") else rel + "/index.html"
    title = text(re.search(r"<h1[^>]*>(.*?)</h1>", s, re.S).group(1))
    m = re.search(r"<main[^>]*>(.*?)</main>", s, re.S)
    body = m.group(1) if m else s[s.find("</header>"):s.find('<section id="contact"')]
    body = re.sub(r"<(script|style|nav|button|form)\b.*?</\1>", " ", body, flags=re.S)
    body = re.sub(r"<h1[^>]*>.*?</h1>", " ", body, flags=re.S)
    parts = re.split(r"(<h2[^>]*>.*?</h2>)", body, flags=re.S)
    entries = []
    heading, anchor = None, ""
    for part in parts:
        h = re.match(r"<h2([^>]*)>(.*?)</h2>", part, re.S)
        if h:
            heading = text(h.group(2))
            a = re.search(r'id="([^"]+)"', h.group(1))
            anchor = "#" + a.group(1) if a else ""
            continue
        body_text = re.sub(r"\s*\n\s*", " ", text(part)).strip()
        if len(body_text) < 60 or (heading or "").lower() in SKIP_HEADINGS:
            continue
        if len(body_text) > MAX_ANSWER:
            body_text = body_text[:MAX_ANSWER].rsplit(" ", 1)[0] + "…"
        name = f"{title}: {heading}" if heading else title
        entries.append({
            "id": "page-" + re.sub(r"[^a-z0-9]+", "-", (rel + "-" + (heading or "intro")).lower()).strip("-")[:80],
            "title": name, "group": title,
            "answer": body_text,
            "links": [{"label": f"Read more: {title}", "href": href + anchor}] + links(part, base_dir)[:3],
            "source": f"{title} page",
        })
    return entries


def pages():
    out = []
    for rel in PAGES:
        out += page_sections(rel)
    return out


def main():
    curated = json.load(open(os.path.join(ROOT, "tools/kb-curated.json"), encoding="utf-8"))
    kb = {"version": 1, "entries": curated + faqs() + forms() + pages()}
    out = os.path.join(ROOT, "assistant/kb.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(kb, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"wrote {out}: {len(curated)} curated, {len(kb['entries']) - len(curated)} from site pages")


if __name__ == "__main__":
    main()
