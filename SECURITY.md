# Security

AirFlash moves files between devices, so it is worth being clear about what it
protects and what it does not. This page is the threat model in plain words,
plus how to report a problem.

## Threat model

### LAN mode (the default)

A node without an access key trusts the network it is on, the same way
AirDrop's "Everyone" setting does.

- Anyone on the network can see device names and send you things. Use it on
  networks you trust (home, not coffee-shop Wi-Fi).
- Nobody can read your inbox: each device makes a random secret, keeps it in
  its own storage, and other devices only ever see a hash of it. Drop and file
  ids are 128-bit random values.
- A sender's display name is not verified. Someone on your LAN could call
  their phone "Mom's iPhone". Pairing and approval are on the roadmap.
- Uploaded files are never rendered. They are served as downloads with a
  sandboxing Content-Security-Policy, so an uploaded HTML or SVG file cannot
  run in the browser against the node's origin.
- The node only answers requests whose `Host` is an IP address, `localhost`,
  `*.local`, its own hostname or a name in `--allowed-hosts`. That blocks
  DNS-rebinding attacks from websites you visit.
- Nodes find each other over mDNS and trust what they find: a host on the LAN
  can advertise `_airflash._tcp` with any address and the node will probe it
  and forward requests to it on behalf of its own UI. In LAN mode that is the
  same trust you already extend to the network.

### Relay mode (a node started with an access key)

On the internet the LAN assumptions stop holding, so a node with an access key
switches into relay mode. See [docs/relay-mode.md](docs/relay-mode.md) for the
design.

- **Access key**: one shared key gates the inbox, the device list, the event
  stream and creating drops. It is compared in constant time and never
  printed. The "Connect a device" QR code encodes only the relay's address,
  never the key.
- **Tokens as capabilities**: every drop has an upload token that only its
  creator holds, and share links are capabilities: whoever has the 8-character
  code can open the link. Nothing else about a drop is reachable without its
  id or code.
- **Brute-force guard**: more than 20 wrong keys from one address in 10
  minutes blocks that address for 10 minutes. Unknown share codes are counted
  the same way. IPv6 clients are counted per /64.
- **Quotas**: a per-file cap, a cap on the declared bytes of all live drops, a
  free-disk reserve, and a short grace period for drops whose files never
  arrive. Everything expires (24 h on a typical relay) and is wiped on restart.
- **DNS rebinding and host checks** apply as in LAN mode; a relay should bind
  `127.0.0.1` and be reached only through its tunnel or reverse proxy.

### What the relay operator can see

The relay stores files in the clear for their lifetime. Whoever runs the
machine can read every file and text drop on it while it exists, and can see
device names and client addresses in the logs. Treat a relay like a friend's
computer, not like a sealed envelope.

## Known limitations

- **No end-to-end encryption.** Transport is HTTPS on a relay (through the
  tunnel) and plain HTTP on the LAN. The node itself sees plaintext.
- **Secrets in query strings.** `EventSource` cannot send headers, so the
  event stream carries the access key and the device secret as `?key=` and
  `?device=`. Those URLs land in whatever sits in front of the node: tunnel
  logs, proxy logs, browser history.
- **LAN peers trust mDNS.** See above; a malicious host on your LAN can
  present itself as a peer.
- **No accounts.** One key for everyone on a relay; rotating it logs everyone
  out. Per-person keys fit behind the same `authorize()` hook and are on the
  roadmap.
- **QR rendering takes caller-supplied text.** `GET /api/qr.svg` renders up to
  1000 characters of whatever the caller passes. On a relay it requires the
  access key (sent as `?key=`, since an `<img>` cannot carry a header, so it
  shares the query-string caveat above); on a LAN node it is open like
  everything else.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
vulnerability reporting on this repository:

https://github.com/michaelmandich/airflash/security/advisories/new

Include what you found, how to reproduce it, and which mode (LAN or relay) it
affects. You will get an acknowledgement, and a fix or a published advisory
once there is one. There is no bug bounty.

## Supported versions

AirFlash is pre-1.0. Only the latest commit on `main` is supported; fixes are
not backported to older tags.
