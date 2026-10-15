# swiftssh

Remote shell and fast, resumable file transfer over HTTPS with SSH-style key auth.
Use your normal `ssh` login once to start swiftssh on a host. After that, connect through swiftssh.

```bash
npm i -g swiftssh

swiftssh deploy prod me@prod.example.com   # one-time: ssh in, start swiftssh, authorize your key, pin its cert
swiftssh connect prod                      # interactive shell
swiftssh push prod ./build.tar.gz /srv/    # parallel, resumable, checksummed upload
swiftssh pull prod /var/log/app.log .
swiftssh exec prod -- systemctl restart app
```

## Why HTTPS instead of SCP/SFTP

SSH and HTTPS both run over TCP, so moving to HTTPS alone doesn't help with packet loss. The speedup comes from how swiftssh uses it:

| Problem with scp/sftp | What swiftssh does |
|---|---|
| One TCP stream per transfer. A lost packet halves the throughput of the whole transfer. | Files are split into chunks and sent over **N parallel TLS connections** (`--parallel`, default 8). A lost packet slows only one of them. |
| SSH's own channel flow-control window caps throughput on high-latency links (the reason HPN-SSH exists). | Plain HTTPS, so throughput is limited only by TCP. |
| A dropped connection means starting over. | The server records which chunks it has received. Rerunning the same `push` **resumes**. |
| Integrity is left to TCP. | Every chunk carries a SHA-256, and the whole file is checked again before the atomic rename into place. |

The next step for lossy links is HTTP/3 (QUIC). It recovers from packet loss per stream and doesn't stall the whole connection. See the roadmap.

## Security model

- **Host identity:** on first start the server creates a self-signed TLS certificate in `~/.swiftssh/`. Clients **pin its SHA-256 fingerprint**, like `known_hosts`. If the fingerprint ever changes, the connection is refused with `HOST IDENTIFICATION CHANGED`.
  - `deploy` gets the certificate through your already-authenticated SSH session, so you're never asked to trust it on first use.
  - `add` shows the fingerprint and asks you to compare it against what `swiftssh serve` printed on the host.
- **Client identity:** an Ed25519 key in `~/.swiftssh/id_ed25519`, plus an `authorized_keys` file on the server.
  - The server sends a random nonce. The client signs `nonce + server cert fingerprint`, which binds the signature to that one server so it can't be replayed elsewhere.
  - In return the client gets a 12-hour bearer token.
- No custom crypto: TLS comes from Node/OpenSSL, signatures from Node's `crypto` Ed25519.

## Protocol (v1)

| Endpoint | Purpose |
|---|---|
| `POST /v1/auth/challenge` → `POST /v1/auth/verify` | Key-based login, returns a bearer token |
| `POST /v1/upload/init` | Declare `{path, size, sha256, chunkSize}`, get back an upload id plus the chunks the server already has |
| `PUT /v1/upload/chunk?id&index` | Raw chunk body, checked against the `x-chunk-sha256` header |
| `POST /v1/upload/complete?id` | Verify the whole-file hash, then atomically rename into place |
| `GET /v1/stat?path&hash=1`, `GET /v1/file?path` (Range) | Downloads via parallel range requests |
| `WSS /v1/shell?cmd&pty&cols&rows` | Shell or exec. Binary frames start with a stream id byte (0 stdin / 1 stdout / 2 stderr). Text frames are JSON control messages (`hello`, `resize`, `eof`, `exit`). |

The server uses a real PTY when `node-pty` is installed (an optional dependency) and falls back to plain pipes otherwise.

## Development

```bash
npm install
npm test            # end-to-end: real server + client on localhost
```

Run the server and client on one machine by giving each its own `SWIFTSSH_HOME`:

```bash
SWIFTSSH_HOME=/tmp/srv node bin/swiftssh.js serve --port 7022
```

```bash
SWIFTSSH_HOME=/tmp/srv node bin/swiftssh.js authorize "$(node bin/swiftssh.js keygen)"
```

```bash
node bin/swiftssh.js add local 127.0.0.1:7022
```

Until the package is published to npm, test `deploy` against a host where you've cloned the repo:
`swiftssh deploy box me@box --remote-cmd "node ~/swiftssh/bin/swiftssh.js"`.

## Roadmap

1. **Publish to npm** so that `deploy`'s default `npx -y swiftssh` works on any host that has Node.
2. **Directory sync**: `push -r` with a manifest diff, so only changed files are sent (rsync-style).
3. **HTTP/3 / QUIC transport** for lossy links, keeping HTTPS/1.1 as the fallback.
4. **Accounts and a desktop app** (Termius-style): a hosted account that syncs your host list and public keys between devices, with an Electron or Tauri UI built on the same client library. The private key stays on each device.
5. **Hardening**: rate-limit auth, per-key permissions such as a root dir or read-only access, audit log, and systemd/launchd service install.
6. **Port forwarding** over the same WebSocket channel.
