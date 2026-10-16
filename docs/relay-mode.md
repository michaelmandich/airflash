# Relay mode

The same node that runs on your PC can run on a small server behind a public
hostname (say `relay.example.com`, through a Cloudflare Tunnel or any HTTPS
reverse proxy). On the internet the LAN assumptions stop holding, so a node
started with an access key switches into *relay mode*. Nothing changes for LAN
nodes without a key.

```
phone/app ──https──▶ Cloudflare edge ──tunnel──▶ cloudflared ──▶ 127.0.0.1:4747 (node, relay mode)
```

`deploy/pi/` has an installer, a systemd unit and tunnel notes for running
this on a Raspberry Pi. This page is about what the node itself does.

## What relay mode changes

| Concern | LAN node | Relay node |
|---|---|---|
| Who can send | anyone on the network | anyone with the **access key** |
| Who can receive a link | anyone with the link | same (links are capabilities, no key needed) |
| Expiry | 15 min | configurable, typically 24 h (`--ttl 24h`) |
| Discovery | mDNS between nodes | off (`--no-discovery`) |
| Request size | unlimited | 100 MB per request behind Cloudflare → **chunked uploads** |
| Client IP | socket address | `CF-Connecting-IP` when `--trust-proxy` |
| Node info | LAN URLs listed | URLs hidden |

## Access key

- Server: `--access-key <key>` / `AIRFLASH_ACCESS_KEY`, or `--access-key-file`
  so the key never sits in a process list. Compared in constant time. Designed
  as `authorize(req)` so per-person keys ("subscribers") can be added later
  without touching the routes.
- Clients send it as `X-AirFlash-Key: <key>`, or `?key=` where headers are
  impossible (`EventSource`). The web UI asks for it once on a `401` and keeps
  it in `localStorage`; the iOS app has a field for it on the Server screen.
- **Required**: `GET /api/devices`, `GET /api/events`, `POST /api/me`,
  `GET /api/drops` (inbox), `POST /api/drops`, everything under `/peer/`.
- **Not required**: `GET /api/node` (URLs hidden), `GET /api/drops/:id`,
  file downloads, `GET /api/link/:code`, static files, and file uploads:
  the per-drop upload token already proves the uploader created the drop
  with the key, and native background uploaders cannot always add headers.
- Share codes grow from 6 to 8 characters in relay mode (drawn uniformly from
  the 31-letter alphabet).
- Brute-force guard: more than 20 failed key checks from one IP in 10 minutes
  → `429` for that IP for 10 minutes. On a relay, unknown share codes on
  `GET /api/link/:code` are counted the same way (own counter, same limits),
  since the code is the only thing guarding a link drop. IPv6 clients are
  counted per /64; the counters hold at most 10,000 clients (oldest out).

## Chunked uploads

Whole-file `PUT /api/drops/:id/files/:fid?token=T` stays and is what LAN
clients use. Through Cloudflare a request body cannot exceed 100 MB, so:

```
GET  /api/node                                  → limits: { maxRequestBytes, chunkBytes }
PUT  /api/drops/:id/files/:fid/chunks/:n?token=T   raw body, exactly chunkBytes except the last
GET  /api/drops/:id/files/:fid/chunks?token=T      → { received: [n, ...] }   (resume after a drop)
POST /api/drops/:id/files/:fid/complete?token=T    → marks the file done once every chunk is in
```

- `chunkBytes` is 32 MiB by default (`--chunk-bytes`), which keeps a chunk well
  under both the Cloudflare cap and its 100 s origin timeout on slow uplinks.
  It is clamped to `maxRequestBytes` when that is set: a chunk is one request.
- The file is pre-sized from the declared `size`; chunk `n` is written at
  offset `n × chunkBytes` through a write stream of its own (opened and closed
  inside that request), so chunks may arrive out of order or be retried, and a
  drop deleted mid-chunk aborts the chunk rather than leaving a stream on a
  closed fd.
- Clients pick: whole-file PUT when `size ≤ maxRequestBytes`, chunks otherwise.
  Set `--max-request-bytes 100mb` on a relay behind Cloudflare; LAN nodes
  leave it unlimited.
- iOS: the background uploader sends whole files, so on a relay the app is
  limited to `maxRequestBytes` until the native chunked uploader lands (a
  small Swift plugin: slice to temp files, background `PUT` per chunk). Over
  the LAN it is unaffected. Files over the cap are refused with a toast; send
  them from a computer or over the LAN.

## Quotas

- `--max-file-bytes` (default 16 GiB) and `--max-store-bytes` (unlimited by
  default) on top of the existing free-disk reserve; `507` when exceeded.
- A drop with files reserves its declared size from creation, but only for a
  grace period (15 minutes, or the ttl if shorter) until its first file or
  chunk lands; then the full ttl applies. A picker that was abandoned with 7 GB
  selected frees the store after 15 minutes, not 24 hours. Text-only drops get
  the full ttl at once.
- Expired drops are deleted from disk as on the LAN; the Pi unit keeps relay
  data in `/var/lib/airflash` and wipes it on every start (still temporary by
  design).

## Not in this version

Accounts, per-person keys, end-to-end encryption, resumable *downloads*, and
sending from a browser that is not on the key. All of these fit behind
`authorize(req)` and the chunk API without changing the client contract. The
share-link cards still say "anyone on this network" on a relay.

## Flags and environment (`bin/airflash.js`)

| Flag | Env | Default | Notes |
|---|---|---|---|
| `--access-key K` | `AIRFLASH_ACCESS_KEY` | none (LAN mode) | any key switches relay mode on |
| `--access-key-file F` | `AIRFLASH_ACCESS_KEY_FILE` | | trimmed; wins over the inline key; empty or unreadable → exit 78 |
| `--ttl 24h` | `AIRFLASH_TTL` | `15m` | `ms`/`s`/`m`/`h`/`d`; a bare number is minutes |
| `--max-request-bytes 100mb` | `AIRFLASH_MAX_REQUEST_BYTES` | unlimited | advertised in `limits`; `kb/mb/gb` decimal, `kib/mib/gib` binary |
| `--chunk-bytes 32mib` | `AIRFLASH_CHUNK_BYTES` | 32 MiB | |
| `--max-file-bytes 16gib` | `AIRFLASH_MAX_FILE_BYTES` | 16 GiB | per file, `413` |
| `--max-store-bytes 12gb` | `AIRFLASH_MAX_STORE_BYTES` | unlimited | declared bytes of live drops, `507` |
| `--trust-proxy` | `AIRFLASH_TRUST_PROXY=1` (also `true`/`yes`/`on`; `0`/`false`/`no`/`off` = off; anything else → exit 78) | off | client IP from `CF-Connecting-IP`, else first `X-Forwarded-For`, only when the value is an IP address |
| `--cors-origins a,b` | `AIRFLASH_CORS_ORIGINS` | app WebView origins | extra web origins allowed on `/api` and `/peer` |

The banner says `Relay mode: on/off`, the limits and, on a relay, `Client IP:
CF-Connecting-IP / X-Forwarded-For (trust-proxy)` or `Client IP: socket
address`; it never prints the key. A relay bound to loopback without
`--trust-proxy` gets a `WARNING` line: every visitor is then `127.0.0.1` to
the guard, so one person's wrong keys would block everyone.

Configuration errors (unreadable or empty key file, a bad `--ttl` or
`--*-bytes` value, an unknown `AIRFLASH_TRUST_PROXY` spelling) exit with
status **78** (`EX_CONFIG`); crashes exit 1. A systemd unit should carry
`RestartPreventExitStatus=78` so a typo stays down with one clear line instead
of restarting every 3 seconds (the unit in `deploy/pi/` does).

## Behaviour worth knowing

- `GET /api/node` carries `relay` and `limits: { maxRequestBytes, chunkBytes, ttlMs }`
  on every node (LAN nodes say `relay: false`, `maxRequestBytes: null`); the
  SSE `hello.node` has the same shape. A relay omits `urls` and `hostnameUrl`.
- `401 {"error":"Access key required"}` for no key, `401 {"error":"Wrong access
  key"}` for a bad one, `429 {"error":"Too many wrong access keys; try again
  later"}` with `Retry-After` once an IP is blocked. Only *wrong* keys count
  toward the guard (a first-time visitor's EventSource retries would
  otherwise lock them out); the 21st wrong key within 10 minutes is the first
  `429`. CORS headers ride on the 401/429 so the browser can read them.
- `X-AirFlash-Key` is in `Access-Control-Allow-Headers` on every node, so a
  stored key never breaks a preflight against a LAN node (which ignores it).
- `DELETE /api/drops/:id` stays token-or-own-device, no key.
- Chunk routes are token-only. `PUT …/chunks/:n` wants `Content-Length`
  exactly `chunkBytes` (the last chunk: the remainder); `400` otherwise,
  `409` while the same chunk is in flight, idempotent `200` for a chunk the
  node already has, `409` once the file is done. `GET …/chunks` lists every
  chunk for a done file, so a Retry after a lost `complete` answer goes
  straight to `POST …/complete`, which is idempotent (`200 {file}`).
- Each finished chunk extends the drop's expiry like a finished file does;
  an idle partial expires `ttl` after its last chunk and is deleted.
- `maxRequestBytes` is advertised, not enforced: the proxy in front is the
  one that caps a request. The node accepts a whole-file `PUT` of any size
  under `maxFileBytes`.
- 5xx answers are masked (`Something went wrong`) unless the error asked to be
  shown (the `507`s); the real reason, fs paths included, goes to the log.
- Web client (`src/web/lib/client.js`): the key is stored in
  `localStorage['airflash.key']` and sent only when set, and only to our own
  node (relative URLs or the configured origin); the iOS server picker's
  probe of a typed or Bonjour-found address is a bare `GET /api/node`. LAN
  traffic is byte-identical without a key, reconnects included: once a hello
  said `relay: false`, a dead stream is simply retried in 2 s. On a relay a
  `401`/`429` opens the Access key sheet (event `airflash:needkey`, with
  `source: 'stream' | 'request'`) and pauses the EventSource reconnect loop
  until a key is saved; a visitor who arrived through a share link (`/d/CODE`)
  and has no key is left alone, since links need none. Uploads go whole when
  `size ≤ maxRequestBytes`, else in chunks with two in flight, a resync from
  `GET …/chunks` after a lost request, and a Retry that re-sends only what is
  missing.

## Tests

`test/relay.test.js` (key gate, guard, link guard, /64 buckets, trust-proxy,
quota, grace), `test/guard.test.js` (the counter and the address buckets),
`test/chunks.test.js` (the chunk routes, a drop deleted mid-chunk, the
complete/PUT race, masked 500s, the chunk clamp), `test/chunks-e2e.test.js`
(the browser's uploader from `src/web/lib/chunks.js` against a real relay
node: six chunks, a lost chunk resumed from `GET …/chunks`, a Retry that sends
only what is missing), `test/client.test.js` (what the web client sends where,
LAN reconnects, the stream's key prompt), `test/bin.test.js` (exit 78, the
trust-proxy switch, the banner). All run with `npm test`.

## Example relay configuration

An environment file for a relay behind a Cloudflare Tunnel, as the systemd
unit in `deploy/pi/` reads it (the unit passes `--no-discovery` on the command
line):

```
AIRFLASH_HOST=127.0.0.1
AIRFLASH_ALLOWED_HOSTS=relay.example.com
AIRFLASH_ACCESS_KEY_FILE=/etc/airflash/access.key
AIRFLASH_TTL=24h
AIRFLASH_MAX_REQUEST_BYTES=100mb
AIRFLASH_MAX_STORE_BYTES=12gb
AIRFLASH_TRUST_PROXY=1
```

Generate the key once, readable by the service user only. `/etc/airflash`
itself must stay traversable by that user (`755`, or `750` owned by
`root:airflash`): the node reads the file as `airflash`, and an unreadable
or empty key file is a configuration error (exit 78).

```bash
sudo sh -c 'umask 077; openssl rand -base64 24 > /etc/airflash/access.key'
sudo chmod 600 /etc/airflash/access.key
sudo chown airflash:airflash /etc/airflash/access.key
sudo systemctl restart airflash
sudo journalctl -u airflash -n 5   # "listening on :4747 (relay mode: access key required)"
```

Hand the key to people out of band (`sudo cat /etc/airflash/access.key`);
never paste it into a chat log, a commit or a doc. The web UI asks for it once
and the iOS app has a field on its Server screen. To rotate it, write a new
file and restart: everyone enters the new key once.
