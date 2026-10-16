# Publishing AirFlash: Cloudflare Tunnel

`https://relay.example.com` → Cloudflare edge → tunnel (outbound from the box)
→ `cloudflared` on the box → `http://127.0.0.1:4747` (AirFlash, relay mode).

No port forward, no inbound firewall rule. The box dials out to Cloudflare;
nothing dials in. The tunnel gets its own name and its own credentials; if you
already run other tunnels on the same account, this one does not touch them.

```
 phone / laptop ──https──▶ Cloudflare edge (TLS ends here)
                              │   no Access policy: AirFlash's own access key is the gate
                              ▼
                    tunnel "airflash"  (outbound QUIC from the box, port 7844; tcp 443 fallback)
                              │
                 airflash-pi
                    cloudflared ──▶ 127.0.0.1:4747  AirFlash node, relay mode
```

Two ways to build it. Option A keeps everything on the box and needs the
dashboard only for a one-time authorisation; Option B creates the tunnel in
the dashboard and runs a token-driven connector. Pick one.

## Option A: locally managed tunnel (recommended)

All on the box, as root. Replace `example.com`, `relay.example.com` and
`<TUNNEL-ID>` with yours.

1. **Package**, from Cloudflare's own apt repo. The suite is literally `any`;
   `dists/<codename>/` is not published for every Debian release.

   ```bash
   sudo install -d -m 0755 /usr/share/keyrings
   curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
   echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
     | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt-get update && sudo apt-get install -y cloudflared
   ```

2. **Authorise** the box once. The command prints a
   `https://dash.cloudflare.com/argotunnel?...` URL and waits; open it on any
   device, sign in, pick `example.com`, **Authorize**. That writes
   `/root/.cloudflared/cert.pem` on the box (an account-level credential; it
   is deleted in step 6). Keep the ssh session open until it returns.

   ```bash
   sudo HOME=/root cloudflared tunnel login
   ```

3. **Create the tunnel** and write its config:

   ```bash
   sudo HOME=/root cloudflared tunnel create airflash      # prints <TUNNEL-ID>; writes /root/.cloudflared/<TUNNEL-ID>.json
   sudo install -d -m 0700 /etc/cloudflared
   sudo mv /root/.cloudflared/<TUNNEL-ID>.json /etc/cloudflared/
   sudo chmod 0600 /etc/cloudflared/<TUNNEL-ID>.json
   sudo tee /etc/cloudflared/config.yml >/dev/null <<'EOF'
   tunnel: <TUNNEL-ID>
   credentials-file: /etc/cloudflared/<TUNNEL-ID>.json
   metrics: 127.0.0.1:20241
   originRequest:
     connectTimeout: 10s
   ingress:
     - hostname: relay.example.com
       service: http://127.0.0.1:4747
     - service: http_status:404
   EOF
   sudo cloudflared tunnel ingress validate
   ```

   `metrics: 127.0.0.1:20241` is what `verify.sh` reads (`/ready`) to prove
   the tunnel is connected. The `http_status:404` catch-all is mandatory.

4. **Run it as a service.** `cloudflared service install` writes
   `/etc/systemd/system/cloudflared.service` from the config, with no secret
   on its command line.

   ```bash
   sudo cloudflared service install
   sudo systemctl enable --now cloudflared
   sudo cloudflared tunnel info airflash        # shows the connections
   ```

5. **Publish.** This creates the proxied CNAME `relay.example.com →
   <TUNNEL-ID>.cfargotunnel.com`; from here the hostname is live. Do it only
   once `verify.sh` on the node says relay mode is on.

   ```bash
   sudo HOME=/root cloudflared tunnel route dns airflash relay.example.com
   ```

6. **Delete the account certificate** and confirm it is gone. The tunnel
   credentials in `/etc/cloudflared/` are all the service needs.

   ```bash
   sudo rm -f /root/.cloudflared/cert.pem
   sudo ls -la /root/.cloudflared/        # no cert.pem
   sudo bash /opt/airflash/deploy/pi/verify.sh
   ```

Rotating or revoking later: stop the service, `cloudflared tunnel delete
airflash` (needs a fresh `tunnel login`; delete `cert.pem` again afterwards)
or delete the tunnel in the dashboard (**Networks → Tunnels**). The DNS record
is never touched by that and must be deleted by hand.

## Option B: dashboard-created tunnel with a token

In Zero Trust: **Networks → Tunnels → Create a tunnel → Cloudflared**, name it,
and add a public hostname `relay.example.com → http://127.0.0.1:4747`. The
dashboard shows a `cloudflared service install eyJ...` command; the long value
is the tunnel token, the one secret. Do not run that command as shown: it
puts the token on the `ExecStart` line of a world-readable unit file.

Instead, `install-connector.sh` installs the package and the hardened unit
next to it (`cloudflared.service`: `DynamicUser`, `ProtectSystem=strict`,
no token on the command line) and stores the token in
`/etc/cloudflared/tunnel-token.env` (root, 0600), which the unit reads as
`EnvironmentFile`. The token reaches the script through one of:

- `TUNNEL_TOKEN` in the environment (automation that already holds it safely),
- `TUNNEL_TOKEN_FILE`, a root-only file holding just the token (default
  `/etc/cloudflared/tunnel.token`; deleted once installed),
- stdin: at a terminal the prompt hides the input and pasting the whole
  `cloudflared service install eyJ...` line is fine, the last word is taken.

```bash
sudo bash /opt/airflash/deploy/pi/cloudflared/install-connector.sh
```

It is idempotent: re-run it to upgrade `cloudflared`, to reinstall the unit,
or to replace the token. The hostname is live as soon as it exists in the
dashboard, so add it there only when the node is ready.

## What the hostname exposes once published

AirFlash runs in **relay mode** (`docs/relay-mode.md`): sending needs the
access key, links are capabilities. Through the tunnel, **anyone** who knows
the name can:

| Path | Without the key, anyone can… |
|---|---|
| `/` | open the UI; it asks for the access key before it shows devices or lets them send |
| `/api/node` | see the node's name, version, port and limits; **not** its addresses (hidden on a relay) |
| `/api/link/<code>` | open a share link; codes are 8 chars from a 31-char alphabet, expire with the drop |
| `/api/drops/<id>`, `…/files/<fid>` | fetch a drop or a file **if they hold its 128-bit id**, i.e. were sent the link |
| `PUT …/files/<fid>?token=T`, chunk routes | upload into a drop **if they hold its upload token**, which only the key-holder who created the drop has |

Everything else, listing devices, the event stream, registering a device,
reading an inbox, **creating a drop**, rendering a QR code (`/api/qr.svg`),
and `/peer/*` (nothing there anyway:
discovery is off), answers `401 Access key required`. Repeated wrong keys from
one address lock that address out for a while, keyed on `CF-Connecting-IP`
(`AIRFLASH_TRUST_PROXY=1`), so one person's typos cannot lock everyone out.

Properties that make this acceptable:

- **Everything is temporary.** Drops expire after the TTL (`AIRFLASH_TTL`,
  24 h by default) and the store is wiped at every service start.
- **The node binds 127.0.0.1 only**, so other hosts on the box's network
  segment cannot reach it, and the box needs no inbound rule at all.
- **Uploads never render as HTML/SVG/scripts**; they are served as downloads
  with a sandboxing CSP, and filenames are sanitised.
- **Quotas**: per request (`AIRFLASH_MAX_REQUEST_BYTES`, 100 MB by default,
  Cloudflare's free-plan cap; chunked uploads go around it), live drops
  (`AIRFLASH_MAX_STORE_BYTES`, 12 GB by default), a disk reserve; `507` beyond
  that.

Still worth knowing:

- Whoever has the access key can send to any device that has connected. The
  key is `/etc/airflash/access.key` on the box (`airflash`, 0600), read only by
  the service; rotation is in the main README. Never paste it into chat, a
  commit or a doc.
- **Cloudflare's free plan caps request bodies at 100 MB.** The web client
  switches to 32 MiB chunks above that.
- **Option, one click, free:** a Cloudflare Access policy on the hostname
  (**Access → Applications → Add → Self-hosted**, with an identity provider of
  your choice) would additionally require a sign-in before the UI even loads.
  Not applied here because the access key is the gate, and an Access login
  would also block share links for people without an account at that provider.

## Files

| File | Runs on | Does |
|---|---|---|
| `../verify.sh` | the box, root | `cloudflared.service active`, no token on the command line, no `cert.pem` left, tunnel connected (`/ready` on the metrics port), `https://relay.example.com/api/node` reaches **this** node |
| `install-connector.sh`, `cloudflared.service` | the box, root | Option B: package, hardened unit, token kept in a root-only env file |

## Reversing it

On the box:

```bash
sudo systemctl disable --now cloudflared
sudo cloudflared service uninstall
sudo HOME=/root cloudflared tunnel delete -f airflash      # Option A; needs cert.pem: re-run `tunnel login` first, delete cert.pem after
sudo rm -rf /etc/cloudflared /root/.cloudflared
sudo rm -f /etc/apt/sources.list.d/cloudflared.list /usr/share/keyrings/cloudflare-main.gpg
sudo systemctl daemon-reload
sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y cloudflared
```

In the dashboard: **DNS → Records**, delete the hostname's CNAME (deleting a
tunnel never touches DNS); **Networks → Tunnels**, confirm `airflash` is gone.
Nothing touched your router, so there is no firewall state to restore.
