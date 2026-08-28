import puppeteer from "@cloudflare/puppeteer";

const ZENODO = "https://zenodo.org/api/deposit/depositions";

function json(data, status) {
  if (status === void 0) status = 200;
  return new Response(JSON.stringify(data), { status: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

function authorized(request, env) {
  if (!env.ERRATA_TOKEN) return false;
  return (request.headers.get("X-Erratta-Token") || "") === env.ERRATA_TOKEN;
}

function doiToRecordId(doi) {
  const m = (doi || "").match(/zenodo\.(\d+)/);
  return m ? m[1] : null;
}

function r2Prefix(paper) {
  const raw = (paper && (paper.r2_path || paper.r2_key)) || "";
  let p = raw.replace(/^qnfo-releases\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return p ? p + "/" : "";
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function markdownToHtml(md) {
  const body = (md || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
  const lines = body.split("\n");
  const out = [];
  let inCode = false, inUl = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf("```") === 0) {
      if (inCode) { out.push("</code></pre>"); inCode = false; }
      else { out.push("<pre><code>"); inCode = true; }
      continue;
    }
    if (inCode) { out.push(esc(line)); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { const n = h[1].length; out.push("<h" + n + ">" + inline(h[2]) + "</h" + n + ">"); continue; }
    if (/^\s*[-*+]\s+/.test(line)) {
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push("<li>" + inline(line.replace(/^\s*[-*+]\s+/, "")) + "</li>");
      continue;
    }
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (/^\s*$/.test(line)) { out.push(""); continue; }
    out.push("<p>" + inline(line) + "</p>");
  }
  if (inUl) out.push("</ul>");
  if (inCode) out.push("</code></pre>");
  const content = out.join("\n");
  const head = "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Paper</title>"
    + "<script src='https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js' async></script>"
    + "<style>body{max-width:40em;margin:2em auto;font-family:Georgia,serif;line-height:1.6;padding:0 1em}</style>"
    + "</head><body>";
  return head + content + "</body></html>";
}

// v0.6.0: in-Worker PDF regeneration via Cloudflare Browser Rendering (@cloudflare/puppeteer).
async function renderPdf(env, html) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    return pdf;
  } finally {
    await browser.close();
  }
}

async function zenodo(env, path, opts) {
  const sep = path.indexOf("?") >= 0 ? "&" : "?";
  const url = ZENODO + path + sep + "access_token=" + env.ZENODO_TOKEN;
  const headers = { "User-Agent": "QNFO-errata-publish/0.6" };
  const init = { method: (opts && opts.method) || "GET", headers: headers };
  if (opts && opts.jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.jsonBody);
  }
  const resp = await fetch(url, init);
  const text = await resp.text();
  let d;
  try { d = JSON.parse(text); } catch (e) { d = { error: text }; }
  if (!resp.ok) throw new Error("zenodo " + resp.status + ": " + text.slice(0, 200));
  return d;
}

async function publishNewVersion(env, action, paper) {
  const recordId = doiToRecordId(paper.doi || action.paper_doi);
  if (!recordId) throw new Error("cannot derive record id from " + (paper.doi || action.paper_doi));
  const nv = await zenodo(env, "/" + recordId + "/actions/newversion", { method: "POST" });
  const draftId = nv.id;
  const slug = paper.slug || "paper";
  // v0.6.0: all three renderings replaced (PDF regenerated in-Worker). Only slug files touched; sources preserved.
  const mainNames = [slug + ".md", slug + ".html", slug + ".pdf"];
  const files = nv.files || [];
  let deletedCount = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = f.filename || "";
    if (mainNames.indexOf(name) >= 0) {
      const dr = await fetch(f.links.self + "?access_token=" + env.ZENODO_TOKEN, { method: "DELETE" });
      if (!dr.ok) throw new Error("delete failed for " + name + ": " + dr.status);
      deletedCount++;
    }
  }
  if (deletedCount !== mainNames.length) {
    throw new Error("delete-count mismatch: deleted " + deletedCount + " of " + mainNames.length + " expected renderings; aborting");
  }
  const mdBlob = new Blob([action.corrected_md || ""], { type: "text/markdown" });
  const fd1 = new FormData();
  fd1.append("file", mdBlob, slug + ".md");
  await fetch(ZENODO + "/" + draftId + "/files?access_token=" + env.ZENODO_TOKEN, { method: "POST", body: fd1 });
  const html = markdownToHtml(action.corrected_md);
  const fd2 = new FormData();
  fd2.append("file", new Blob([html], { type: "text/html" }), slug + ".html");
  await fetch(ZENODO + "/" + draftId + "/files?access_token=" + env.ZENODO_TOKEN, { method: "POST", body: fd2 });
  // v0.6.0: regenerate + upload the PDF in-Worker. Failure is non-fatal (md/html authoritative); surfaced in report.
  let pdf = null;
  let pdfError = null;
  try {
    pdf = await renderPdf(env, html);
    const fd3 = new FormData();
    fd3.append("file", new Blob([pdf], { type: "application/pdf" }), slug + ".pdf");
    await fetch(ZENODO + "/" + draftId + "/files?access_token=" + env.ZENODO_TOKEN, { method: "POST", body: fd3 });
  } catch (e) {
    pdfError = e.message;
    console.error("PDF regeneration failed:", e.message);
  }
  const meta = nv.metadata || {};
  if (action.version_to) meta.version = action.version_to;
  const metaClean = {};
  for (const k in meta) {
    if (k !== "prereserve_doi" && k !== "doi" && k !== "recid") metaClean[k] = meta[k];
  }
  try {
    const pr = await fetch("https://zenodo.org/api/records/" + recordId, { headers: { "User-Agent": "QNFO-errata-publish/0.6" } }).then(function (r) { return r.json(); });
    const prRels = (pr.metadata && pr.metadata.related_identifiers) || [];
    const parentCustom = prRels.filter(function (r) {
      const rel = (r.relationType || r.relation || "").toLowerCase();
      return rel.indexOf("version") < 0 && rel.indexOf("obsolet") < 0;
    }).map(function (r) {
      return { identifier: r.relatedIdentifier || r.identifier, relation: r.relationType || r.relation, scheme: r.scheme || "doi" };
    });
    const draftRels = (metaClean.related_identifiers || []).filter(function (r) {
      const rel = (r.relation || "").toLowerCase();
      return rel.indexOf("version") < 0 && rel.indexOf("obsolet") < 0;
    });
    const merged = draftRels.slice();
    for (let pi = 0; pi < parentCustom.length; pi++) {
      const pc = parentCustom[pi];
      const dup = merged.some(function (m) { return m.identifier === pc.identifier && m.relation === pc.relation; });
      if (!dup) merged.push(pc);
    }
    if (merged.length) metaClean.related_identifiers = merged;
  } catch (e) { /* keep draft relations on fetch failure */ }
  await zenodo(env, "/" + draftId, { method: "PUT", jsonBody: { metadata: metaClean } });
  const pub = await zenodo(env, "/" + draftId + "/actions/publish", { method: "POST" });
  return { newDoi: pub.doi, newRecordId: pub.id, conceptrecid: pub.conceptrecid, version: action.version_to, pdf: pdf, pdfError: pdfError };
}

async function repointStores(env, action, paper, pub) {
  if (!pub.newDoi) throw new Error("publish response missing doi; aborting store re-point");
  const status = {};
  await env.PAPERS_DB.prepare(
    "UPDATE papers SET body_md=?1, version=?2, doi=?3, zenodo_doi=?3, updated_at=datetime('now') WHERE slug=?4"
  ).bind(action.corrected_md || "", action.version_to || paper.version, pub.newDoi, paper.slug).run();
  status.d1 = "ok";
  const kgId = "paper:" + paper.slug;
  const node = await env.GRAPH_DB.prepare("SELECT properties FROM nodes WHERE id=?1").bind(kgId).first();
  if (node) {
    let props = {};
    try { props = JSON.parse(node.properties || "{}"); } catch (e) { props = {}; }
    props.doi = pub.newDoi;
    props.zenodo_url = "https://doi.org/" + pub.newDoi;
    props.version = action.version_to || paper.version;
    await env.GRAPH_DB.prepare("UPDATE nodes SET properties=?1, updated_at=datetime('now') WHERE id=?2").bind(JSON.stringify(props), kgId).run();
    status.kg = "ok";
  } else {
    status.kg = "missing-node";
  }
  if (env.MIRROR) {
    const prefix = r2Prefix(paper);
    if (prefix) {
      try {
        await env.MIRROR.put(prefix + paper.slug + ".md", action.corrected_md || "");
        await env.MIRROR.put(prefix + paper.slug + ".html", markdownToHtml(action.corrected_md || ""));
        if (pub.pdf) await env.MIRROR.put(prefix + paper.slug + ".pdf", pub.pdf);
        status.r2 = "ok";
      } catch (e) { status.r2 = "error: " + e.message; }
    } else {
      status.r2 = "no-prefix";
    }
  } else {
    status.r2 = "no-binding";
  }
  return status;
}

async function notifyUser(env, action, paper, pub, err) {
  if (!env.SEND_EMAIL) return { skipped: "no send_email binding" };
  try {
    const subject = (err ? "QNFO errata publish FAILED: " : "QNFO errata published: ") + ((paper && paper.slug) || (action && action.paper_doi) || "");
    const lines = err
      ? ["The auto-publish of an errata correction failed.", "", "Paper: " + ((paper && paper.slug) || (action && action.paper_doi) || ""), "Error: " + err]
      : ["An errata correction was published automatically (cloud pipeline).", "", "Paper: " + ((paper && paper.slug) || ""), "New DOI: " + (pub.newDoi || ""), "Version: " + (pub.version || ""), "PDF: " + (pub.pdf ? "regenerated in-worker" : "failed (" + (pub.pdfError || "n/a") + ")"), "", "This is an automatic receipt. A post-publish adversarial audit is recommended."];
    const text = lines.join("\n");
    await env.SEND_EMAIL.send({ to: "rwnquni@outlook.com", from: "qnfo@qnfo.org", subject: subject, text: text, html: "<pre>" + text.replace(/</g, "&lt;") + "</pre>" });
    return { sent: true };
  } catch (e) { return { sent: false, error: e.message }; }
}

async function publishAction(env, action) {
  const paper = await env.PAPERS_DB.prepare(
    "SELECT slug, title, version, doi, zenodo_doi, body_md, r2_path, r2_key FROM papers WHERE doi=?1 OR zenodo_doi=?1 LIMIT 1"
  ).bind(action.paper_doi).first();
  if (!paper) {
    await env.WATCH_DB.prepare("UPDATE errata_actions SET status='error', updated_at=datetime('now') WHERE id=?").bind(action.id).run();
    await notifyUser(env, action, null, null, "paper not found for " + action.paper_doi);
    return { action_id: action.id, error: "paper not found for " + action.paper_doi };
  }
  if (action.version_from && paper.version && String(action.version_from) !== String(paper.version)) {
    await env.WATCH_DB.prepare("UPDATE errata_actions SET status='stale', updated_at=datetime('now') WHERE id=?").bind(action.id).run();
    return { action_id: action.id, slug: paper.slug, error: "stale draft: version_from " + action.version_from + " != current " + paper.version };
  }
  await env.WATCH_DB.prepare("UPDATE errata_actions SET status='publishing', updated_at=datetime('now') WHERE id=?").bind(action.id).run();
  let pub;
  try {
    pub = await publishNewVersion(env, action, paper);
  } catch (e) {
    await env.WATCH_DB.prepare("UPDATE errata_actions SET status='error', updated_at=datetime('now') WHERE id=?").bind(action.id).run();
    await notifyUser(env, action, paper, null, e.message);
    return { action_id: action.id, slug: paper.slug, error: e.message };
  }
  let repoint;
  try {
    repoint = await repointStores(env, action, paper, pub);
  } catch (e) {
    await env.WATCH_DB.prepare("UPDATE errata_actions SET status='error', updated_at=datetime('now') WHERE id=?").bind(action.id).run();
    await notifyUser(env, action, paper, null, "published but store re-point failed: " + e.message);
    return { action_id: action.id, slug: paper.slug, error: e.message, published: pub };
  }
  await env.WATCH_DB.prepare("UPDATE errata_actions SET status='published', updated_at=datetime('now') WHERE id=?").bind(action.id).run();
  const notify = await notifyUser(env, action, paper, pub, null);
  return { action_id: action.id, slug: paper.slug, published: pub, repoint: repoint, notify: notify };
}

async function runPublish(env, mode) {
  const dry = mode === "dry";
  if (!dry) {
    const stuck = await env.WATCH_DB.prepare(
      "SELECT id, paper_doi, slug FROM errata_actions WHERE status='publishing' AND updated_at < datetime('now','-60 minutes') ORDER BY id ASC LIMIT 5"
    ).all();
    const stuckRows = (stuck && stuck.results) || [];
    for (let si = 0; si < stuckRows.length; si++) {
      const s = stuckRows[si];
      await env.WATCH_DB.prepare("UPDATE errata_actions SET status='error', updated_at=datetime('now') WHERE id=?").bind(s.id).run();
      await notifyUser(env, { paper_doi: s.paper_doi }, s.slug ? { slug: s.slug, doi: s.paper_doi } : null, null, "publish row stuck at 'publishing' >60min (possible worker eviction mid-publish); marked error for manual review");
    }
  }
  const items = await env.WATCH_DB.prepare(
    "SELECT id, queue_id, paper_doi, slug, version_from, version_to, risk, corrected_md FROM errata_actions WHERE status='drafted' AND risk='low' ORDER BY id ASC LIMIT 5"
  ).all();
  const rows = (items && items.results) || [];
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (dry) {
      const paper = await env.PAPERS_DB.prepare(
        "SELECT slug, version, doi, r2_path, r2_key FROM papers WHERE doi=?1 OR zenodo_doi=?1 LIMIT 1"
      ).bind(a.paper_doi).first();
      results.push({ action_id: a.id, dry: true, paper: paper ? paper.slug : null, record_id: doiToRecordId(paper ? paper.doi : a.paper_doi), r2_prefix: paper ? r2Prefix(paper) : null, version_to: a.version_to, corrected_md_len: (a.corrected_md || "").length, would_publish: true, pdf: "in-worker-render" });
      continue;
    }
    try { results.push(await publishAction(env, a)); } catch (e) { results.push({ action_id: a.id, error: e.message }); }
  }
  return { ok: true, worker: "qnfo-errata-publish", version: "0.6.0", dry: dry, processed: rows.length, results: results };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if ((url.pathname.startsWith("/run/") || url.pathname.startsWith("/debug/")) && !authorized(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (url.pathname === "/health") {
      return json({ ok: true, worker: "qnfo-errata-publish", version: "0.6.0", bindings: { zenodo: !!env.ZENODO_TOKEN, papers: !!env.PAPERS_DB, watch: !!env.WATCH_DB, graph: !!env.GRAPH_DB, mirror: !!env.MIRROR, send_email: !!env.SEND_EMAIL, browser: !!env.BROWSER, auth: !!env.ERRATA_TOKEN } });
    }
    if (url.pathname === "/debug/pdf") {
      try {
        const html = "<html><head><meta charset='utf-8'><title>QNFO PDF test</title><script src='https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js' async></script></head><body style='max-width:40em;margin:2em auto;font-family:Georgia,serif'><h1>QNFO PDF test</h1><p>Inline math: $E = mc^2$ and $x^2$.</p><p>This PDF was generated in-Worker by Cloudflare Browser Rendering.</p></body></html>";
        const pdf = await renderPdf(env, html);
        return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Length": String(pdf.length || 0) } });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }
    if (url.pathname === "/run/publish") {
      const mode = url.searchParams.get("mode") || "dry";
      try { return json(await runPublish(env, mode)); } catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(event, env, ctx) {
    try {
      const r = await runPublish(env, "live");
      console.log("[qnfo-errata-publish] cron done:", JSON.stringify({ processed: r.processed, results: r.results }));
    } catch (e) {
      console.error("[qnfo-errata-publish] cron error:", e.message);
    }
  }
};
