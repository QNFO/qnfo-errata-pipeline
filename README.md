# qnfo-errata-pipeline

Cloud-native errata pipeline for QNFO published papers. Fully autonomous: detects inbound emails that request corrections/errata to QNFO papers, drafts the correction, stages it, and publishes a Zenodo newversion — all in Cloudflare Workers, no local processing, no manual trigger, no user input.

## Workers

| Worker | Version | Cron | Role |
|---|---|---|---|
| `qnfo-errata-watch` | 0.2.0 | `0 * * * *` | Detect errata emails (Workers AI classification + DOI extraction) → `errata_queue` |
| `qnfo-errata-respond` | 0.4.0 | `15 * * * *` | Resolve paper (concept-DOI fallback) → AI-draft surgical additive correction → stage in `errata_actions` → notify |
| `qnfo-errata-publish` | 0.6.0 | `30 * * * *` | Zenodo newversion (replace `.md`/`.html`/`.pdf`) → re-point D1/KG/R2 → notify |

## publish worker — in-Worker PDF regeneration (v0.6.0)

The publish worker regenerates the PDF **in-Worker** via Cloudflare Browser Rendering (`@cloudflare/puppeteer`):

- `renderPdf(env, html)` launches the browser binding, sets the corrected HTML content (`waitUntil: "networkidle0"` so MathJax loads from CDN), and calls `page.pdf({ format: "A4", printBackground: true })`.
- In `publishNewVersion`: all three renderings (`<slug>.md/.html/.pdf`) are deleted from the newversion draft, then the corrected `.md`, regenerated `.html`, and **regenerated `.pdf`** are uploaded. PDF failure is **non-fatal** (the `.md`/`.html` are authoritative; the failure is surfaced in the notification/report for a follow-up render).
- The R2 mirror also receives the regenerated PDF.
- `/debug/pdf` (auth-gated) renders a sample MathJax page to PDF — a live end-to-end check of the render path.

## Bindings (publish worker)

- D1 `WATCH_DB` → `qnfo-audit` (errata_queue/errata_actions/errata_watch)
- D1 `PAPERS_DB` → `living-paper`
- D1 `GRAPH_DB` → `qnfo-graph` (KG nodes)
- R2 `MIRROR` → `qnfo-releases`
- `SEND_EMAIL` (send_email) → receipt notifications to the user mailbox
- `BROWSER` (browser) → Cloudflare Browser Rendering for in-Worker PDF
- Secrets: `ZENODO_TOKEN` (deposit API), `ERRATA_TOKEN` (shared auth for `/run/*` + `/debug/*`; fail-closed)

## Compatibility

`compatibility_date: "2026-08-10"` + `compatibility_flags: ["nodejs_compat"]` (required by `@cloudflare/puppeteer` for `node:buffer`).

## Build + deploy

```bash
npm install @cloudflare/puppeteer esbuild
npx wrangler deploy --dry-run --outdir=dist   # bundles @cloudflare/puppeteer into dist/worker.js
python deploy_pdf.py                          # uploads dist/worker.js via the Workers API with the exact bindings
```

Auth: all `/run/*` + `/debug/*` endpoints require the `X-Erratta-Token` header matching the `ERRATA_TOKEN` secret (401 otherwise). `/health` stays public.

## Red-team verified (2026-08-28)

Both pass-1 (10 HARD) and pass-2 (6 SOFT) findings on the publish worker are remediated (v0.6.0); the v1.1 errata artifact (`10.5281/zenodo.22144215`) is clean across Accuracy/Completeness/Dependency.
