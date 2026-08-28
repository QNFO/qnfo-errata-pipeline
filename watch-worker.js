const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const NOISE = /bounce|dmarcreport|dmarc|cfbounces|noreply|no-reply|sciforum|evalsignal|wildapricot|glintopenaccess|primeoa|esciencelibrary|premiersciencenetwork|theopenresearchnetwork|gitlab|soverin|microsoft\.com/i;

function json(data, status) {
  if (status === void 0) status = 200;
  return new Response(JSON.stringify(data), { status: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

function authorized(request, env) {
  // 0.2.1 (kaizen AUTH-FAIL-CLOSED-1): FAIL CLOSED — if the token binding is ever missing, reject all /run/* + /debug/*.
  if (!env.ERRATA_TOKEN) return false;
  return (request.headers.get("X-Erratta-Token") || "") === env.ERRATA_TOKEN;
}

async function classifyErrata(env, email) {
  const prompt = [
    "You are QNFO's errata-detection assistant. Given an inbound email to the QNFO researcher (Rowan Brad Quni-Gudzinas), decide whether it requests or implies a correction/errata to one of QNFO's published papers.",
    "Set errata=true when the sender (typically an author whose work QNFO cited, attributed, or engaged) indicates that a QNFO paper misrepresents, mis-attributes, miscites, or wrongly describes their own work. Key signals: \"this equation is nowhere mentioned in our work\", \"we never said/claimed this\", \"you attributed X to us but that is not ours\", \"that is incorrect\", \"please correct\", \"this does not appear in our paper\". An explicit request for a correction/errata is also errata=true.",
    "Set errata=false for: polite acknowledgements (\"I will take a look\", \"thanks for sharing\"), scheduling/co-working, conference logistics, outreach declines, benchmark pitches, newsletters, bounces, DMARC reports, spam.",
    "From: " + (email.sender || ""),
    "Subject: " + (email.subject || ""),
    "Body: " + (email.body_text || "").slice(0, 1500),
    'Respond with JSON only: {"errata": bool, "paper_doi": string-or-null, "claim": string-or-null, "confidence": float}'
  ].join("\n");
  const res = await env.AI.run(MODEL, { messages: [{ role: "user", content: prompt }] }, { gateway: { id: "default" } });
  let text = "";
  try { text = (res && (res.response || res.result || "")).toString(); } catch (e) { text = ""; }
  text = text.trim();
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) text = text.slice(a, b + 1);
  try { return JSON.parse(text); } catch (e) { return { errata: false, paper_doi: null, claim: null, confidence: 0 }; }
}

async function runCheck(env, mode) {
  const dry = mode === "dry";
  const db = env.WATCH_DB;
  const w = await db.prepare("SELECT value FROM errata_watch WHERE key = 'last_email_id'").first();
  const lastId = w ? parseInt(w.value || "0", 10) : 0;
  const emails = await db.prepare("SELECT id, sender, recipient, subject, body_text, received_at FROM emails WHERE id > ? AND classification = 'personal' ORDER BY id ASC LIMIT 12").bind(lastId).all();
  const rows = (emails && emails.results) || [];
  let maxId = lastId, classified = 0;
  const detected = [];
  for (const e of rows) {
    maxId = Math.max(maxId, e.id);
    if (NOISE.test(e.sender || "") || NOISE.test(e.subject || "")) continue;
    classified++;
    let cls;
    try { cls = await classifyErrata(env, e); } catch (err) { cls = { errata: false, error: err.message }; }
    if (cls && cls.errata) {
      let doi = cls.paper_doi || null;
      if (!doi) {
        const dm = ((e.subject || "") + " " + (e.body_text || "")).match(/10\.5281\/zenodo\.\d+/);
        if (dm) doi = dm[0];
      }
      if (!dry) {
        await db.prepare("INSERT OR IGNORE INTO errata_queue (email_id, sender, subject, paper_doi, claim, confidence, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'detected', datetime('now'), datetime('now'))").bind(e.id, e.sender, e.subject, doi, cls.claim || null, cls.confidence || 0).run();
      }
      detected.push({ email_id: e.id, sender: e.sender, subject: e.subject, paper_doi: doi, claim: cls.claim || null });
    }
  }
  if (!dry && maxId > lastId) {
    await db.prepare("INSERT INTO errata_watch (key, value) VALUES ('last_email_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(maxId)).run();
  }
  return { ok: true, worker: "qnfo-errata-watch", version: "0.2.1", dry: dry, model: MODEL, lastEmailId: lastId, advancedTo: maxId, scanned: rows.length, classified: classified, detectedCount: detected.length, detected: detected };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if ((url.pathname.startsWith("/run/") || url.pathname.startsWith("/debug/")) && !authorized(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (url.pathname === "/health") {
      return json({ ok: true, worker: "qnfo-errata-watch", version: "0.2.1", bindings: { ai: !!env.AI, d1: !!env.WATCH_DB, auth: !!env.ERRATA_TOKEN }, model: MODEL });
    }
    if (url.pathname === "/run/check") {
      const mode = url.searchParams.get("mode") || "dry";
      try { return json(await runCheck(env, mode)); } catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(event, env, ctx) {
    try {
      const r = await runCheck(env, "live");
      console.log("[qnfo-errata-watch] cron done:", JSON.stringify({ scanned: r.scanned, classified: r.classified, detected: r.detectedCount }));
    } catch (e) { console.error("[qnfo-errata-watch] cron error:", e.message); }
  }
};
