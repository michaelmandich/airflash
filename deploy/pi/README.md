# Run AirFlash as a public relay on a Raspberry Pi (or any Debian/Ubuntu box) behind a Cloudflare Tunnel

This folder turns a small always-on box into an AirFlash **relay**: a node that
anyone can reach at `https://relay.example.com`, where sending needs an access
key, share links work for everyone, and nothing stays longer than the TTL.
The box never opens an inbound port; it dials out to Cloudflare and the
tunnel delivers requests to a node that listens on loopback only.

```
 phone / laptop, anywhere ──https──▶ Cloudflare edge (TLS ends here)
                                        │   tunnel: outbound from the box, no inbound port
                                        ▼
                         airflash-pi (any Debian/Ubuntu, arm64 or amd64)
                             cloudflared ──▶ 127.0.0.1:4747  AirFlash node, relay mode
                                              • binds loopback only, --no-discovery
                                              • runs as user `airflash`, hardened unit
                                              • drops expire (24 h); store wiped at every start
```

Everything in this folder is idempotent and runs on the box itself; nothing
here changes your router or your DNS by hand (the tunnel creates its own
record).

## What the relay exposes

Once the hostname is published, **anyone** who knows it can open the UI, open
a share link they were given, and download a drop whose id they hold. They
cannot see the device list, read inboxes, register a device or **send**
anything without the access key, and a burst of wrong keys from one address
locks that address out for a while (`docs/relay-mode.md`). Drops expire
(`AIRFLASH_TTL`, 24 h by default) and the store is wiped at every service
start. Uploads are served as downloads under a sandboxing CSP, never rendered.
The node binds `127.0.0.1` only, so nothing on the box's own network can reach
it directly, and the box needs no inbound firewall rule.
[cloudflared/README.md](cloudflared/README.md#what-the-hostname-exposes-once-published)
has the full path-by-path table.

Two limits to know: Cloudflare's free plan caps a request body at **100 MB**
(the web client switches to chunked uploads above that), and there is **no LAN
path to the node on 4747**; you reach it through the public hostname like
everyone else, or over `ssh -L 4747:127.0.0.1:4747` for a local look.

## Prerequisites

- A 64-bit Debian 12 (bookworm) or 13 (trixie), Raspberry Pi OS Lite 64-bit,
  or Ubuntu 22.04+ box with `systemd`, `apt` and outbound internet access.
  `dpkg --print-architecture` must say `arm64` or `amd64`; NodeSource has no
  32-bit packages. 1 GB of RAM is plenty.
- A domain whose DNS is on Cloudflare (free plan is fine) and a Cloudflare
  account that can create tunnels.
- ssh access to the box with `sudo`. Make the login key-only before the
  hostname goes public: `verify.sh` checks for it.
- Node 22 and `cloudflared` are installed by the scripts; you do not install
  them yourself.

### Where to put the box

Put the relay on an isolated network segment if you can (a guest network, its
own segment on a managed switch, or a cloud VM are all fine), so that a
compromise through the public hostname cannot reach the rest of your network. The box needs
**outbound** traffic only (apt, GitHub, Cloudflare on 443 and 7844); no
inbound port is required and no port forward should exist. Beyond that, the
placement is your call and nothing in this folder depends on it.

## Step 1: get the kit onto the box

Copy this folder over (nothing else is needed yet; the installer clones the
rest):

```bash
# from your workstation, in the airflash checkout
scp -r deploy/pi pi@airflash-pi:/tmp/airflash-pi
```

## Step 2: install the node

`install.sh` runs as root on the box and takes its settings from the
environment. Two are required:

| Variable | Required | Meaning |
|---|---|---|
| `REPO_URL` | yes (unless `INSTALL_SOURCE`) | where to clone AirFlash from: `https://github.com/YOUR-GITHUB-USER/airflash.git` for a public repo (no key needed), or `git@github.com:YOUR-GITHUB-USER/airflash.git` to use a read-only deploy key the box generates |
| `PUBLIC_HOST` | yes | the hostname the tunnel will publish, e.g. `relay.example.com`; becomes the default `AIRFLASH_ALLOWED_HOSTS` |
| `AIRFLASH_NAME` | no | the name devices see (default: the hostname) |
| `AIRFLASH_PORT` | no | loopback port (default `4747`) |
| `AIRFLASH_ALLOWED_HOSTS` | no | comma-separated hostnames the node answers to; anything else gets `421` (default: `PUBLIC_HOST`) |
| `RELAY` | no | `1` (default) relay mode: access key, 24 h TTL, 100 MB per request, 12 GB store, trust-proxy. `0`: plain LAN node |
| `AIRFLASH_TTL`, `AIRFLASH_MAX_REQUEST_BYTES`, `AIRFLASH_MAX_STORE_BYTES`, `AIRFLASH_TRUST_PROXY`, `AIRFLASH_ACCESS_KEY_FILE` | no | the relay settings; defaults as above |
| `AIRFLASH_HOST`, `AIRFLASH_FLAGS` | no | bind address and extra node flags; `0.0.0.0` and an empty `AIRFLASH_FLAGS` (discovery on) only make sense for a plain LAN node |
| `REPO_BRANCH` | no | default `main` |
| `TMPFS_SIZE` | no | e.g. `1G`: keep drops in RAM instead of on the SD card |
| `INSTALL_SOURCE` | no | copy a local checkout instead of cloning (tests, USB/rsync deploys) |
| `FORCE_ENV=1` | no | rewrite `/etc/airflash/airflash.env` from the values above (it is kept otherwise) |
| `DETACH=0` | no | run in the foreground instead of under `systemd-run` |

Without `REPO_URL` and `PUBLIC_HOST` the script prints its usage and exits
with status 64; it never guesses them.

```bash
# on the box
sudo env REPO_URL=https://github.com/YOUR-GITHUB-USER/airflash.git \
         PUBLIC_HOST=relay.example.com \
         bash /tmp/airflash-pi/install.sh
```

What happens, in order: apt packages and Node 22 from NodeSource; a system
user `airflash` with no shell; clone into `/opt/airflash` and
`npm ci --omit=dev` (no Electron); `/etc/airflash/airflash.env`; the access
key (relay mode); `/var/lib/airflash`; the hardened `airflash.service`; and a
few checks (bound to `127.0.0.1` only, `/api/node` answers, the public
hostname is accepted). The long part runs detached under `systemd-run`, so a
dropped ssh session cannot leave `dpkg` half-configured; re-run the same
command to re-attach, and in general re-run it whenever you like. Output ends
with `=== INSTALL-DONE ===`.

**With an ssh `REPO_URL`** (a private fork), the first run generates
`/etc/airflash/deploy_key`, prints only its public half and stops with exit
code 2. Your step: add that line to the repo as a read-only deploy key
(*Settings → Deploy keys*, title `airflash-node@<hostname>`, *Allow write
access* off), then run the same command again. GitHub's host keys are pinned
in `/etc/airflash/github_known_hosts`; there is no trust-on-first-use.

Settings live in `/etc/airflash/airflash.env` afterwards; edit it and
`sudo systemctl restart airflash`. A configuration error exits with status 78
and the unit stays down instead of restart-looping
(`journalctl -u airflash -n 5` says why).

## Step 3: the access key

Relay mode generates `/etc/airflash/access.key` (owner `airflash`, mode 600)
on the first run and never prints it. Read it once, out of band, and hand it
to the people who may send through the relay:

```bash
sudo cat /etc/airflash/access.key
```

Rotate it any time:

```bash
sudo sh -c 'umask 077; openssl rand -base64 24 > /etc/airflash/access.key'
sudo chown airflash:airflash /etc/airflash/access.key
sudo systemctl restart airflash
```

Never paste the key into a commit, a doc or a chat log.

## Step 4: publish it with a Cloudflare Tunnel

[cloudflared/README.md](cloudflared/README.md) has the full version. The short
one, all on the box:

1. Install `cloudflared` from Cloudflare's apt repo.
2. `cloudflared tunnel login`: it prints a URL; open it, pick your domain,
   authorize. That writes an account certificate to `/root/.cloudflared/cert.pem`.
3. `cloudflared tunnel create airflash`, then move the tunnel credentials to
   `/etc/cloudflared/` (root, 0600) and write `/etc/cloudflared/config.yml`
   with one ingress rule, `relay.example.com → http://127.0.0.1:4747`, and the
   `http_status:404` catch-all.
4. `cloudflared service install`, `systemctl enable --now cloudflared`. The
   unit carries no secret on its command line.
5. `cloudflared tunnel route dns airflash relay.example.com`. **This is the
   publish step**: it creates the proxied DNS record and the hostname is live.
6. **Delete `/root/.cloudflared/cert.pem`.** It is an account-level credential
   and has no business on an internet-facing box once the tunnel and the DNS
   record exist. `verify.sh` fails while it is still there.

If you would rather create the tunnel in the Zero Trust dashboard and run a
token-driven connector, `cloudflared/install-connector.sh` and
`cloudflared/cloudflared.service` do that with the token kept in a root-only
file; see "Option B" in the cloudflared README.

## Step 5: verify

```bash
sudo bash /opt/airflash/deploy/pi/verify.sh
```

One `PASS` / `FAIL` / `SKIP` line per check: Node version, service user,
loopback-only bind, no mDNS socket, `421` for a foreign `Host` header, the
relay settings and the `401` without a key, the unit's hardening, tunnel
connected (via cloudflared's metrics endpoint on `127.0.0.1:20241`), the
account certificate gone, and finally that `https://relay.example.com/api/node`
reaches **this** node (the `nodeId` matches). It ends with
`ALL-CHECKS-PASSED` or `CHECKS-FAILED: n`. `SKIP` means "not applicable
yet" and says why. `PUBLIC_HOST=other.example.com` overrides the hostname it
probes.

Then the test that counts: from a phone on mobile data, open the hostname in
a private window, enter the key, send a photo to a browser tab on another
machine and a text back. Both should arrive, and both should be gone after the
TTL.

## Upgrades

```bash
sudo bash /opt/airflash/deploy/pi/update.sh
```

Fast-forward pull (over the deploy key when there is one), `npm ci`, reinstall
the unit if it changed in the repo, restart, show `/api/node`. The checkout on
the box is never meant to carry local changes; a non-fast-forward is an error.

## Day-to-day

```bash
sudo bash /opt/airflash/deploy/pi/verify.sh      # PASS/FAIL/SKIP per check
journalctl -u airflash -f                         # the node's log
journalctl -u cloudflared -f                      # the tunnel's log
sudo systemctl restart airflash                   # after editing /etc/airflash/airflash.env
```

To unpublish without uninstalling anything, delete the hostname's DNS record
in the Cloudflare dashboard (**DNS → Records**) or stop `cloudflared`.

## Reversing everything

Each step is independent of the others.

1. Cloudflare dashboard: delete the hostname's CNAME under **DNS → Records**
   (deleting a tunnel never touches DNS). The hostname is dead at once.
2. On the box, the tunnel (full list in
   [cloudflared/README.md](cloudflared/README.md#reversing-it)):
   `sudo systemctl disable --now cloudflared; sudo cloudflared service uninstall;
   sudo rm -rf /etc/cloudflared /root/.cloudflared; sudo apt-get purge -y cloudflared`,
   then delete the tunnel under **Networks → Tunnels** if it is still listed.
3. On the box, the node:
   `sudo systemctl disable --now airflash; sudo rm -rf /opt/airflash /etc/airflash
   /var/lib/airflash /etc/systemd/system/airflash.service
   /etc/systemd/system/var-lib-airflash.mount; sudo userdel airflash;
   sudo rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/preferences.d/nodesource;
   sudo apt-get purge -y nodejs`.
4. If you added a deploy key: repo **Settings → Deploy keys**, delete
   `airflash-node@<hostname>`.

Nothing was changed on your router, so there is nothing to restore there.

## Files

| Path | Runs on | Purpose |
|---|---|---|
| `install.sh` | the box, root | idempotent installer (Node 22, user, optional deploy key, clone, `npm ci`, env file, access key, unit); detached under `systemd-run` |
| `update.sh` | the box, root | pull, `npm ci`, restart, status |
| `verify.sh` | the box, root | PASS/FAIL/SKIP assertions for install, service, network, relay, tunnel and the public hostname |
| `airflash.service` | the box | the hardened unit (loopback, `--no-discovery`, `ProtectSystem=strict`, `RestartPreventExitStatus=78`, …) |
| `cloudflared/` | the box + dashboard | the tunnel: locally managed flow (README), token-driven alternative (`install-connector.sh`, `cloudflared.service`), exposure table, reversal |
| `test/` | your workstation, Docker | container tests: arm64 bookworm/trixie (install, start, verify, cloudflared package) and an amd64 systemd container (units, hardening, detach, update, tmpfs) |

## Testing without hardware

Both test runners need Docker (Docker Desktop with binfmt for the arm64
images) and mount the repo read-only into throwaway containers:

```bash
bash deploy/pi/test/run-container-tests.sh      # arm64 bookworm + trixie, no systemd
bash deploy/pi/test/run-systemd-test.sh         # amd64, systemd as PID 1: the real units
```

They set `PUBLIC_HOST=relay.example.com` and `INSTALL_SOURCE=/src`, so no
network clone and no real hostname are involved.
