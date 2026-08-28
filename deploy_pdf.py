import requests, json, time

TOKEN = open(r"C:\Users\LENOVO\tokens\cloudflare").read().strip()
ACCT = "edb167b78c9fb901ea5bca3ce58ccc4b"
NAME = "qnfo-errata-publish"
WORKER = r"C:\Users\LENOVO\AppData\Local\Temp\qnfo-pdf-bundle\dist\worker.js"

worker = open(WORKER, "rb").read()
print("bundle bytes:", len(worker))

metadata = json.dumps({
    "main_module": "worker.js",
    "compatibility_date": "2026-08-10",
    "compatibility_flags": ["nodejs_compat"],
    "bindings": [
        {"type": "d1", "name": "WATCH_DB", "database_id": "35e2e573-92f3-46ac-83c6-22f6429fc5e5"},
        {"type": "d1", "name": "PAPERS_DB", "database_id": "70a58cb3-b2cd-498d-877f-ecca86859a22"},
        {"type": "d1", "name": "GRAPH_DB", "database_id": "a1954b92-d681-4d02-b1f6-f9a2eb4c265d"},
        {"type": "r2_bucket", "name": "MIRROR", "bucket_name": "qnfo-releases"},
        {"type": "send_email", "name": "SEND_EMAIL"},
        {"type": "browser", "name": "BROWSER"}
    ]
})

boundary = "----qnfo" + str(int(time.time() * 1000))
def part(fname, value, ctype=None, filename=None):
    disp = 'Content-Disposition: form-data; name="%s"' % fname
    if filename:
        disp += '; filename="%s"' % filename
    head = "--" + boundary + "\r\n" + disp + "\r\n"
    if ctype:
        head += "Content-Type: " + ctype + "\r\n"
    head += "\r\n"
    return head.encode("utf-8") + value + b"\r\n"

body = part("metadata", metadata.encode("utf-8"), "application/json") \
     + part("worker.js", worker, "application/javascript+module", "worker.js") \
     + ("--" + boundary + "--\r\n").encode("utf-8")

r = requests.put(
    "https://api.cloudflare.com/client/v4/accounts/%s/workers/scripts/%s" % (ACCT, NAME),
    headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "multipart/form-data; boundary=" + boundary},
    data=body, timeout=120
)
print("deploy status:", r.status_code)
print(r.text[:400])
