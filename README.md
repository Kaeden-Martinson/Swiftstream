# swiftssh

Remote shell and fast, resumable file transfer over HTTPS with SSH-style key auth.
Use your normal `ssh` login once to start swiftssh on a host. After that, connect through swiftssh.

There are two ways to use it: the **desktop app** (terminal and file browser) or the **`swiftssh` command**. Both use the same saved servers and key, in `~/.swiftssh`.

## Desktop app

Download `SwiftSSH-Setup-<version>.exe` and run it. Choose **Add a server**, enter the SSH login you already use (like `ubuntu@203.0.113.7`), and the app sets the server up. After that:

- **Terminal tab:** a full terminal on the server. Copy with Ctrl+Shift+C.
- **Files tab:** browse folders, drag files or folders in to upload, select items and press Download. Transfers show their progress at the bottom right and resume if interrupted.
- **Error messages** say what went wrong and what to do. If the server stopped, a **Start server again** button restarts it over SSH.

Log in with a password or your SSH key. The password is used only for that one login, plus `sudo` if Node.js has to be installed, and is never saved. From then on the app uses its own key.

To build it yourself, see [Development](#development).

## Command line

```bash
npm i -g swiftssh

swiftssh connect ubuntu@box.example.com    # first time: asks for the password, installs itself, opens a shell
swiftssh connect box                       # afterwards: by its saved name, no password
swiftssh setup                             # or a guided version of the same
swiftssh connect prod                      # interactive shell
swiftssh push prod ./build.tar.gz /srv/    # parallel, resumable, checksummed upload
swiftssh pull prod /var/log/app.log .
swiftssh push prod ./site /var/www/        # folders: only changed files are sent
swiftssh bench prod                        # measure scp/sftp vs swiftssh on this host
swiftssh exec prod -- systemctl restart app
swiftssh hosts                             # list saved servers;  swiftssh remove <name> to forget one
```

Run `swiftssh` on its own for the list of commands, and `swiftssh <command> --help` for details on one. Errors explain the fix, for example the exact `swiftssh authorize` line to run when a server doesn't know your key yet. Typos get a "did you mean" suggestion.

## Why HTTPS instead of SCP/SFTP

SSH and HTTPS both run over TCP, so moving to HTTPS alone doesn't help with packet loss. The speedup comes from how swiftssh uses it:

| Problem with scp/sftp | What swiftssh does |
|---|---|
| One TCP stream per transfer. A lost packet halves the throughput of the whole transfer. | Files are split into chunks and sent over **N parallel TLS connections** (`--parallel`, default 8). A lost packet slows only one of them. |
| SSH's own channel flow-control window caps throughput on high-latency links (the reason HPN-SSH exists). | Plain HTTPS, so throughput is limited only by TCP. |
| Many small files are slow: SFTP waits for a round trip on every open, write and close. | Small files are **packed into bundles** of up to 8 MB / 1000 files, sent in parallel. 10,000 files take a few dozen requests. |
| `scp -r` re-sends everything. | Folder transfers compare size and modification time (like rsync's quick check) and **send only what changed**. Timestamps are preserved so the next run can tell. |
| A dropped connection means starting over. | The server records which chunks it has received. Rerunning the same `push` **resumes**. |
| Integrity is left to TCP. | Every chunk carries a SHA-256, and the whole file is checked again before the atomic rename into place. |

Every transfer goes through swiftssh's own HTTPS protocol. SSH is used exactly once, by `deploy`, to start the server.

Run `swiftssh bench <host>` to measure the difference on your own link. It uploads the same 200 MB file and the same 2000 small files with `scp` (which uses the SFTP protocol on OpenSSH 9+) and with swiftssh, then prints both times side by side. Gains are largest on high-latency or lossy links and with many small files. On a fast LAN, a single large file may only be about as fast as scp.

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
| `POST /v1/sync/plan` | Send a folder manifest (`path, size, mtime`), get back which files the server needs |
| `PUT /v1/bundle?root` / `POST /v1/bundle/read` | Many small files in one body: repeated `[u32 header length][header JSON with path, mtime, sha256][bytes]`, then a zero length |
| `GET /v1/list?path` | Recursive listing used by folder pulls |
| `GET /v1/ls?path`, `POST /v1/mkdir` | One folder level and folder creation, for the app's file browser |
| `WSS /v1/shell?cmd&pty&cols&rows` | Shell or exec. Binary frames start with a stream id byte (0 stdin / 1 stdout / 2 stderr). Text frames are JSON control messages (`hello`, `resize`, `eof`, `exit`). |

Shells get a real terminal, so vim, htop and Ctrl+C work:

- with `node-pty` when it's installed (the Void installer builds it);
- otherwise with the system's `script` command (Linux and macOS), where the size is set when the shell opens but later window resizes aren't passed through;
- as a last resort, plain pipes.

## Standalone executable

```bash
npm run build
```

This produces two files:

- `dist/swiftssh.cjs`: the whole CLI and server in one file.
- `dist/swiftssh.exe` (`dist/swiftssh` on macOS and Linux): a single executable with Node built in. Copy it anywhere and run it; nothing else needs to be installed on that computer, not even `ssh`.

The first `swiftssh connect user@host`:

1. Logs in over SSH with the built-in client. It tries your SSH agent and keys first, then asks for the password.
2. On the first connection to a server, shows its SSH host key fingerprint and remembers it. If that key later changes, it refuses to connect.
3. Finds Node.js 18 or newer on the server. If there isn't one, it downloads the official build into `~/.swiftssh/runtime` (checked against nodejs.org's SHA-256 list; no root needed). On musl systems or unusual CPUs it uses the package manager with `sudo` instead.
4. Uploads `swiftssh.cjs` to `~/.swiftssh/bin`, starts it in the background, authorizes this computer's key, and pins its certificate.
5. Opens a shell. Later connections use the saved server and its key, with no password.

If the saved server stops answering (after a reboot, say), `connect` offers to log in and start it again.

The executable embeds the Node version that built it (about 90 MB) and isn't code-signed yet.

## Running on a Void Linux server

`deploy/void/install.sh` installs SwiftSSH as a runit service that starts on boot. It can also publish the website with nginx and HTTPS. Clone the repository on the server and run it as root:

```bash
sudo sh deploy/void/install.sh --user alice --authorize "swiftssh-ed25519 AAAA..."
```

What it does:

- Installs `nodejs`, plus `base-devel` and `python3` so the full terminal (vim, htop) can build. Skip those with `--no-pty`.
- Installs SwiftSSH globally from the checkout, and writes `/etc/sv/swiftssh`, which runs `swiftssh serve` as `--user` on port 7022 (change it with `--port`).
- Sends logs to `/var/log/swiftssh` through `svlogd`, keeping 10 files of 1 MB.
- Prints the server's fingerprint and the exact `swiftssh add` command to run on your computer.

Run it again to update SwiftSSH; it restarts the service. To remove the service, run `--uninstall`, which keeps your keys and files. Day to day: `sv status swiftssh`, `sv restart swiftssh`, `tail -f /var/log/swiftssh/current`.

Open port 7022/tcp in your firewall. The server limits failed logins to 10 per address per 10 minutes, after which that address gets HTTP 429 until the window passes.

To also host the website:

```bash
sudo sh deploy/void/install.sh --user alice --site swiftssh.example.com --email you@example.com
```

This copies `site/` to `/var/www/swiftssh`, installs nginx, gets a Let's Encrypt certificate with certbot, and serves the site over HTTPS. The site gets HSTS, a strict Content Security Policy, gzip, caching for static files, and a 404 page. Point the domain's DNS at the server first, and open ports 80 and 443. Void doesn't ship a cron daemon by default, so install one (`xbps-install cronie`, then `ln -s /etc/sv/cronie /var/service/`) and add the renewal line the script prints.

## Development

```bash
npm install
npm test            # end-to-end: real server + client on localhost
```

The desktop app lives in `app/`. It's an Electron app that runs the same `src/` client code, copied into `app/core` by `npm run sync-core`.

```bash
npm run build                     # the app ships the server bundle from dist/
npm --prefix app install
npm run app         # run the app from source
npm run app:dist    # build app/dist/SwiftSSH-Setup-<version>.exe
```

The website is static files in `site/`. Preview it with `npx serve site`. `app/scripts/make-og.js` regenerates its share image (`npx electron scripts/make-og.js` from `app/`).

The installer isn't code-signed yet, so Windows SmartScreen will warn the first time it runs. Choose "More info", then "Run anyway".

Run the server and client on one machine by giving each its own `SWIFTSSH_HOME`:

```bash
SWIFTSSH_HOME=/tmp/srv node bin/swiftssh.js serve --port 7022
```

```bash
SWIFTSSH_HOME=/tmp/srv node bin/swiftssh.js authorize "$(node bin/swiftssh.js key)"
```

```bash
node bin/swiftssh.js add local 127.0.0.1:7022
```

`npm test` also runs `test/bootstrap.js`. It starts a small SSH server in-process and checks first-time setup with a password, through both the source CLI and `swiftssh.exe` (it needs a POSIX `sh`, such as Git Bash on Windows).

## Roadmap

1. **Publish to npm and GitHub Releases**: `swiftssh.exe` and the app installer, signed.
2. **Delta transfer** for large files that changed slightly (rsync-style rolling checksums), and an optional `--delete` for folder sync.
3. **HTTP/3 / QUIC transport** for lossy links, keeping HTTPS/1.1 as the fallback.
4. **Accounts** (Termius-style): a hosted account that syncs your host list and public keys between devices. The private key stays on each device.
5. **Desktop app polish**: multiple terminal tabs per server, delete/rename in the file browser, auto-update, and signed builds for Windows and macOS.
6. **Hardening**: rate-limit auth, per-key permissions such as a root dir or read-only access, audit log, and systemd/launchd service install.
7. **Port forwarding** over the same WebSocket channel.
