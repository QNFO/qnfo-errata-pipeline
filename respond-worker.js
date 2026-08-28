const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

function json(data, status) {
  if (status === void 0) status = 200;
  return new Response(JSON.stringify(data), { status: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

function authorized(request, env) {
  // 0.4.1 (kaizen AUTH-FAIL-CLOSED-1): FAIL CLOSED — if the token binding is ever missing, reject all /run/* + /debug/*.
  if (!env.ERRATA_TOKEN) return false;
  return (request.headers.get("X-Erratta-Token") || "") === env.ERRATA_TOKEN;
}

function doiToRecordId(doi) {
  const m = (doi || "").match(/zenodo\.(\d+)/);
  return m ? m[1] : null;
}

async function resolvePaper(env, doi) {
  const base = "SELECT slug, title, version, doi, zenodo_doi, body_md FROM papers WHERE doi = ?1 OR zenodo_doi = ?1 LIMIT 1";
  const row = await env.PAPERS_DB.prepare(base).bind(doi).first();
  if (row) return row;
  try {
    const recId = doiToRecordId(doi);
    if (!recId) return null;
    const vresp = await fetch("https://zenodo.org/api/records/" + recId + "/versions?size=10", { headers: { "User-Agent": "QNFO-errata-respond/0.4" } }).then(function (r) { return r.json(); });
    const hits = (vresp && vresp.hits && vresp.hits.hits) || [];
    hits.sort(function (a, b) { return (b.created || "").localeCompare(a.created || ""); });
    if (hits.length) {
      const headDoi = hits[0].doi || null;
      if (headDoi) {
        const row2 = await env.PAPERS_DB.prepare(base).bind(headDoi).first();
        if (row2) return row2;
      }
    }
  } catch (e) { }
  return null;
}

async function draftCorrection(env, item, paper) {
  const prompt = [
    "You are QNFO's errata-implementation assistant. Given (1) an errata email and (2) a QNFO published paper (markdown), produce a SURGICAL, MINIMAL correction.",
    "",
    "HARD RULES:",
    "1. Do NOT change any scientific result, equation, number, data, or conclusion.",
    "2. The correction is ONLY: (a) an attribution/clarification sentence correcting a mis-attribution or miscitation, (b) an acknowledgement sentence naming the correspondent, (c) a changelog entry with a version bump.",
    "3. Provide an EXACT verbatim sentence from the paper (copy-paste, no paraphrase) as the insertion anchor.",
    "",
    "ERRATA EMAIL:",
    "From: " + (item.sender || ""),
    "Subject: " + (item.subject || ""),
    "Body: " + (item.claim || item.subject || ""),
    "",
    "PAPER (markdown):",
    (paper.body_md || "").slice(0, 9000),
    "",
    'Respond with JSON only: {"risk":"low|high","clarification":"<1-3 sentences>","anchor":"<exact verbatim sentence from the paper>","position":"after|before","acknowledgement":"<1 sentence naming the correspondent>","changelog":"<1 line>","version":"<new version label e.g. 1.1>"}'
  ].join("\n");
  const res = await env.AI.run(MODEL, { messages: [{ role: "user", content: prompt }] }, { gateway: { id: "default" } });
  let text = "";
  try { text = (res && (res.response || res.result || "")).toString(); } catch (e) { text = ""; }
  text = text.trim();
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) text = text.slice(a, b + 1);
  try { return JSON.parse(text); } catch (e) { return { risk: "high", clarification: null, anchor: null, position: "after", acknowledgement: null, changelog: null, version: null }; }
}

function insertClarification(md, corr) {
  if (!corr.clarification || !corr.anchor) return { md: md, applied: false, reason: "no clarification or anchor" };
  const idx = md.indexOf(corr.anchor);
  if (idx < 0) return { md: md, applied: false, reason: "anchor not found" };
  const insertAt = corr.position === "before" ? idx : idx + corr.anchor.length;
  const insertText = "\n\n" + corr.clarification + "\n";
  const md2 = md.slice(0, insertAt) + insertText + md.slice(insertAt);
  return { md: md2, applied: true, reason: null };
}

function addAcknowledgementAndChangelog(md, corr) {
  let out = md;
  const block = [];
  if (corr.acknowledgement) block.push("**Acknowledgements:** " + corr.acknowledgement);
  if (corr.changelog) block.push("**Changelog:** " + corr.changelog + (corr.version ? " (v" + corr.version + ")" : ""));
  if (block.length === 0) return out;
  const insertBlock = "\n\n" + block.join("\n\n") + "\n";
  const refIdx = out.indexOf("## References");
  if (refIdx >= 0) {
    out = out.slice(0, refIdx) + insertBlock + out.slice(refIdx);
  } else {
    out = out + insertBlock;
  }
  return out;
}

function bumpVersion(md, version) {
  if (!version) return md;
  let out = md;
  out = out.replace(/\*\*Version:\*\*\s*[^\n]*/, "**Version:** " + version + " (this version).");
  if (/^version:/m.test(out)) {
    out = out.replace(/^(version:\s*["']?)[\d.]+(["']?\s*)$/m, function(m, p1, p2) { return p1 + version + p2; });
  }
  return out;
}

function applyCorrection(paperMd, corr) {
  let md = paperMd;
  const applied = { clarification: false, acknowledgement: false, version: false };
  const r1 = insertClarification(md, corr);
  md = r1.md;
  applied.clarification = r1.applied;
  md = addAcknowledgementAndChangelog(md, corr);
  applied.acknowledgement = !!(corr.acknowledgement || corr.changelog);
  md = bumpVersion(md, corr.version);
  applied.version = !!corr.version;
  return { md: md, applied: applied, anchor_error: r1.reason };
}

async function respondToItem(env, item) {
  const paper = await resolvePaper(env, item.paper_doi);
  if (!paper) {
    await env.WATCH_DB.prepare("UPDATE errata_queue SET status='error', updated_at=datetime('now') WHERE id=?").bind(item.id).run();
    return { error: "paper not found for " + item.paper_doi, item_id: item.id };
  }
  const corr = await draftCorrection(env, item, paper);
  const applied = applyCorrection(paper.body_md, corr);
  const risk = corr.risk || "high";
  await env.WATCH_DB.prepare("INSERT INTO errata_actions (queue_id, email_id, paper_doi, slug, version_from, version_to, risk, clarification, acknowledgement, changelog, corrected_md, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'drafted', datetime('now'), datetime('now'))")
    .bind(item.id, item.email_id, paper.doi || item.paper_doi, paper.slug, paper.version, corr.version, risk, corr.clarification || null, corr.acknowledgement || null, corr.changelog || null, applied.md).run();
  await env.WATCH_DB.prepare("UPDATE errata_queue SET status='audited', updated_at=datetime('now') WHERE id=?").bind(item.id).run();
  const notify = await notifyUser(env, paper, corr, null);
  return { item_id: item.id, slug: paper.slug, risk: risk, applied: applied.applied, anchor_error: applied.anchor_error, notify: notify };
}

async function notifyUser(env, paper, corr, action) {
  if (!env.SEND_EMAIL) return { skipped: "no send_email binding" };
  try {
    const subject = "QNFO errata drafted: " + (paper.slug || paper.doi || "");
    const text = [
      "An inbound email requested a correction to a QNFO paper, and a correction was drafted automatically (cloud pipeline).",
      "",
      "Paper: " + (paper.slug || "") + " (" + (paper.doi || "") + ")",
      "Risk: " + (corr.risk || "high"),
      "Clarification: " + (corr.clarification || "(none)"),
      "Acknowledgement: " + (corr.acknowledgement || "(none)"),
      "Changelog: " + (corr.changelog || "(none)"),
      "New version: " + (corr.version || "(unchanged)"),
      "",
      "This is an automatic receipt. The staged correction is recorded in D1 (errata_actions) and is queued for publication."
    ].join("\n");
    await env.SEND_EMAIL.send({ to: "rwnquni@outlook.com", from: "qnfo@qnfo.org", subject: subject, text: text, html: "<pre>" + text.replace(/</g, "&lt;") + "</pre>" });
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

async function runRespond(env, mode) {
  const dry = mode === "dry";
  const items = await env.WATCH_DB.prepare("SELECT id, email_id, sender, subject, paper_doi, claim FROM errata_queue WHERE status='detected' ORDER BY id ASC LIMIT 5").all();
  const rows = (items && items.results) || [];
  const results = [];
  for (const it of rows) {
    if (dry) { results.push({ item_id: it.id, dry: true }); continue; }
    try { results.push(await respondToItem(env, it)); } catch (e) { results.push({ item_id: it.id, error: e.message }); }
  }
  return { ok: true, worker: "qnfo-errata-respond", version: "0.4.1", dry: dry, processed: rows.length, results: results };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if ((url.pathname.startsWith("/run/") || url.pathname.startsWith("/debug/")) && !authorized(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (url.pathname === "/health") {
      return json({ ok: true, worker: "qnfo-errata-respond", version: "0.4.1", bindings: { ai: !!env.AI, watch: !!env.WATCH_DB, papers: !!env.PAPERS_DB, send_email: !!env.SEND_EMAIL, auth: !!env.ERRATA_TOKEN }, model: MODEL });
    }
    if (url.pathname === "/debug/zenodo") {
      const doi = url.searchParams.get("doi") || "";
      const out = { doi: doi, recId: doiToRecordId(doi) };
      try {
        const rec = await fetch("https://zenodo.org/api/records/" + out.recId, { headers: { "User-Agent": "QNFO-errata-respond/0.4" } });
        out.recStatus = rec.status;
        const recJson = await rec.json();
        out.conceptrecid = recJson.conceptrecid;
        const vresp = await fetch("https://zenodo.org/api/records/" + out.recId + "/versions?size=10", { headers: { "User-Agent": "QNFO-errata-respond/0.4" } });
        out.versionsStatus = vresp.status;
        const vJson = await vresp.json();
        const hits = (vJson.hits && vJson.hits.hits) || [];
        out.hits = hits.map(function (h) { return { id: h.id, doi: h.doi, created: h.created }; });
        out.hitsCount = out.hits.length;
      } catch (e) { out.error = e.message; }
      return json(out);
    }
    if (url.pathname === "/debug/resolve") {
      const doi = url.searchParams.get("doi") || "";
      try {
        const paper = await resolvePaper(env, doi);
        return json({ ok: true, doi: doi, resolved: paper ? { slug: paper.slug, version: paper.version, doi: paper.doi, zenodo_doi: paper.zenodo_doi } : null, method: paper ? (paper.doi === doi || paper.zenodo_doi === doi ? "exact" : "concept-head") : null });
      } catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    if (url.pathname === "/run/respond") {
      const mode = url.searchParams.get("mode") || "dry";
      try { return json(await runRespond(env, mode)); } catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(event, env, ctx) {
    try {
      const r = await runRespond(env, "live");
      console.log("[qnfo-errata-respond] cron done:", JSON.stringify({ processed: r.processed, results: r.results }));
    } catch (e) {
      console.error("[qnfo-errata-respond] cron error:", e.message);
    }
  }
};
