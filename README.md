# Swiftstream

Remote shell and fast, resumable file transfer over HTTPS with SSH-style key auth.
Use your normal `ssh` login once to start Swiftstream on a host. After that, connect through Swiftstream.

Swiftstream was called SwiftSSH. Upgrading needs nothing from you: your key, saved servers and settings are copied from `~/.swiftssh` the first time Swiftstream runs, and servers set up by SwiftSSH are upgraded the next time you connect or restart them.

There are two ways to use it: the **desktop app** (terminal and file browser) or the **`swiftstream` command**. Both use the same saved servers and key, in `~/.swiftstream`.

## Desktop app

Download `Swiftstream-Setup-<version>.exe` and run it. Type an SSH login like `ubuntu@203.0.113.7` in the search bar and press **Connect**. The app logs in once, installs Swiftstream on the server and opens it in a tab.

- **Servers home:** your servers as cards, in groups you choose, with a live status dot on each. Search by name, address, login or group. Right-click a card for terminal, files, edit, restart and remove, plus any actions you've added.
- **Tabs:** each tab is a terminal or a file browser for one server, and a server can have several of each. The **+** button (Ctrl+T) opens a new one for any server. Ctrl+Tab moves between tabs and Ctrl+W closes one. The app reopens the tabs you had open last time.
- **Terminal:** a full terminal on the server. Copy with Ctrl+Shift+C.
- **Files:** your computer on the left, the server on the right.
  - Drag between the two panes, or drag in from Explorer, to transfer. Files go to the folder that's open in the pane you drop on.
  - Double-click a server file to open it in its usual app. Right-click for **Open with** VS Code, Notepad and others. Saving it uploads it back to the server.
  - Each pane has back, forward and up buttons; your mouse's back and forward buttons work too, as do Alt+Left and Alt+Right.
  - Filter a folder with Ctrl+F. Click the path bar (or press Ctrl+L) to type or paste a path.
  - Right-click for open, transfer, rename (F2), delete (Del), new folder and copy path. Deleting on your computer goes to the Recycle Bin; deleting on a server asks first.
  - The app remembers where you uploaded files from each folder on your computer. Next time, it offers that spot, and shows a **Go there** link when you open the same folder on the left.
- **Auto-healing:** the app checks your servers every 30 seconds. If Swiftstream stops or the server reboots, it logs back in over SSH with this computer's key, which setup added to the server's `~/.ssh/authorized_keys`. It then restarts Swiftstream and reconnects your terminal, without needing a password. Where the server has `crontab`, setup also adds an `@reboot` entry so Swiftstream starts on boot.
- **Settings:** turn auto-healing on or off, change how often servers are checked, show or hide dotfiles, and edit your right-click actions. Actions are commands like `df -h` or `tail -f {path}` that run in the server's terminal.

Log in with a password or your SSH key. The password is used only for that one login, plus `sudo` if Node.js has to be installed, and is never saved. From then on the app uses its own key.

To build it yourself, see [Development](#development).

## Command line

```bash
npm i -g swiftstream

swiftstream connect ubuntu@box.example.com  # first time: asks for the password, installs itself, opens a shell
swiftstream connect box                     # afterwards: by its saved name, no password
sws connect box                             # sws is a short alias for swiftstream
swiftstream setup                           # or a guided version of the same
swiftstream connect prod                    # interactive shell
swiftstream push prod ./build.tar.gz /srv/  # parallel, resumable, checksummed upload
swiftstream pull prod /var/log/app.log .
swiftstream push prod ./site /var/www/      # folders: only changed files are sent
swiftstream bench prod                      # measure scp/sftp vs swiftstream on this host
swiftstream exec prod -- systemctl restart app
swiftstream hosts                           # list saved servers;  swiftstream remove <name> to forget one
```

Run `swiftstream` on its own for the list of commands, and `swiftstream <command> --help` for details on one. Errors explain the fix, for example the exact `swiftstream authorize` line to run when a server doesn't know your key yet. Typos get a "did you mean" suggestion.

## Why HTTPS instead of SCP/SFTP

SSH and HTTPS both run over TCP, so moving to HTTPS alone doesn't help with packet loss. The speedup comes from how swiftstream uses it:

| Problem with scp/sftp | What swiftstream does |
|---|---|
| One TCP stream per transfer. A lost packet halves the throughput of the whole transfer. | Files are split into chunks and sent over **N parallel TLS connections** (`--parallel`, default 8). A lost packet slows only one of them. |
| SSH's own channel flow-control window caps throughput on high-latency links (the reason HPN-SSH exists). | Plain HTTPS, so throughput is limited only by TCP. |
| Many small files are slow: SFTP waits for a round trip on every open, write and close. | Small files are **packed into bundles** of up to 8 MB / 1000 files, sent in parallel. 10,000 files take a few dozen requests. |
| `scp -r` re-sends everything. | Folder transfers compare size and modification time (like rsync's quick check) and **send only what changed**. Timestamps are preserved so the next run can tell. |
| A dropped connection means starting over. | The server records which chunks it has received. Rerunning the same `push` **resumes**. |
| Integrity is left to TCP. | Every chunk carries a SHA-256, and the whole file is checked again before the atomic rename into place. |

Every transfer goes through swiftstream's own HTTPS protocol. SSH is used exactly once, by `deploy`, to start the server.

Run `swiftstream bench <host>` to measure the difference on your own link. It uploads the same 200 MB file and the same 2000 small files with `scp` (which uses the SFTP protocol on OpenSSH 9+) and with swiftstream, then prints both times side by side. Gains are largest on high-latency or lossy links and with many small files. On a fast LAN, a single large file may only be about as fast as scp.

The next step for lossy links is HTTP/3 (QUIC). It recovers from packet loss per stream and doesn't stall the whole connection. See the roadmap.

## Security model

- **Host identity:** on first start the server creates a self-signed TLS certificate in `~/.swiftstream/`. Clients **pin its SHA-256 fingerprint**, like `known_hosts`. If the fingerprint ever changes, the connection is refused with `HOST IDENTIFICATION CHANGED`.
  - `deploy` gets the certificate through your already-authenticated SSH session, so you're never asked to trust it on first use.
  - `add` shows the fingerprint and asks you to compare it against what `swiftstream serve` printed on the host.
- **Client identity:** an Ed25519 key in `~/.swiftstream/id_ed25519`, plus an `authorized_keys` file on the server.
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

- `dist/swiftstream.cjs`: the whole CLI and server in one file.
- `dist/swiftstream.exe` (`dist/swiftstream` on macOS and Linux): a single executable with Node built in. Copy it anywhere and run it; nothing else needs to be installed on that computer, not even `ssh`.

The first `swiftstream connect user@host`:

1. Logs in over SSH with the built-in client. It tries your SSH agent and keys first, then asks for the password.
2. On the first connection to a server, shows its SSH host key fingerprint and remembers it. If that key later changes, it refuses to connect.
3. Finds Node.js 18 or newer on the server. If there isn't one, it downloads the official build into `~/.swiftstream/runtime` (checked against nodejs.org's SHA-256 list; no root needed). On musl systems or unusual CPUs it uses the package manager with `sudo` instead.
4. Uploads `swiftstream.cjs` to `~/.swiftstream/bin`, starts it in the background, authorizes this computer's key, and pins its certificate.
5. Opens a shell. Later connections use the saved server and its key, with no password.

If the saved server stops answering (after a reboot, say), `connect` offers to log in and start it again.

The executable embeds the Node version that built it (about 90 MB) and isn't code-signed yet.

## Releasing and publishing the website

The website (`site/`) hosts the downloads itself.

```bash
npm run release
```

This builds everything and puts the files in `site/downloads/`:

| File | What it is |
|---|---|
| `Swiftstream-Setup-<version>.exe` | Desktop app installer for Windows |
| `swiftstream-<version>-win-x64.exe` | Command line for Windows, Node built in |
| `swiftstream-<version>.cjs` | Command line for any system with Node.js 18+ |
| `SHA256SUMS.txt` | Checksums for the files above |
| `latest.json` | What the site reads to fill in links, sizes and checksums |

The site's download buttons always point at the current version, and the main button offers the app on Windows and the command line elsewhere. `npm run release -- --no-app` skips the slow installer build and keeps the last one. The installer is built in `app/release`, so a copy of the app running from `app/dist` doesn't block the build. The built files aren't committed to git.

Then upload the site, downloads included, to your server over Swiftstream. Only changed files are sent:

```bash
npm run publish-site -- <server> [remote folder]
```

The default remote folder is `/var/www/swiftstream`. That's the folder `deploy/void/install.sh --site` serves with nginx and makes writable for your user, so publishing doesn't need root. nginx serves `/downloads/` as file downloads, and `latest.json` uncached so a new release shows up immediately.

## Running on a Void Linux server

`deploy/void/install.sh` installs Swiftstream as a runit service that starts on boot. It can also publish the website with nginx and HTTPS. Clone the repository on the server and run it as root:

```bash
sudo sh deploy/void/install.sh --user alice --authorize "swiftstream-ed25519 AAAA..."
```

What it does:

- Installs `nodejs`, plus `base-devel` and `python3` so the full terminal (vim, htop) can build. Skip those with `--no-pty`.
- Installs Swiftstream globally from the checkout, and writes `/etc/sv/swiftstream`, which runs `swiftstream serve` as `--user` on port 7022 (change it with `--port`).
- Sends logs to `/var/log/swiftstream` through `svlogd`, keeping 10 files of 1 MB.
- Prints the server's fingerprint and the exact `swiftstream add` command to run on your computer.

Run it again to update Swiftstream; it restarts the service. To remove the service, run `--uninstall`, which keeps your keys and files. Day to day: `sv status swiftstream`, `sv restart swiftstream`, `tail -f /var/log/swiftstream/current`.

Open port 7022/tcp in your firewall. The server limits failed logins to 10 per address per 10 minutes, after which that address gets HTTP 429 until the window passes.

To also host the website:

```bash
sudo sh deploy/void/install.sh --user alice --site swiftstream.example.com --email you@example.com
```

This copies `site/` to `/var/www/swiftstream`, installs nginx, gets a Let's Encrypt certificate with certbot, and serves the site over HTTPS. The site gets HSTS, a strict Content Security Policy, gzip, caching for static files, and a 404 page. Point the domain's DNS at the server first, and open ports 80 and 443. Void doesn't ship a cron daemon by default, so install one (`xbps-install cronie`, then `ln -s /etc/sv/cronie /var/service/`) and add the renewal line the script prints.

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
npm run app:dist    # build app/dist/Swiftstream-Setup-<version>.exe
```

The website is static files in `site/`. Preview it with `npx serve site`. `app/scripts/make-og.js` regenerates its share image (`npx electron scripts/make-og.js` from `app/`).

The installer isn't code-signed yet, so Windows SmartScreen will warn the first time it runs. Choose "More info", then "Run anyway".

Run the server and client on one machine by giving each its own `SWIFTSTREAM_HOME`:

```bash
SWIFTSTREAM_HOME=/tmp/srv node bin/swiftstream.js serve --port 7022
```

```bash
SWIFTSTREAM_HOME=/tmp/srv node bin/swiftstream.js authorize "$(node bin/swiftstream.js key)"
```

```bash
node bin/swiftstream.js add local 127.0.0.1:7022
```

`npm test` also runs `test/bootstrap.js`. It starts a small SSH server in-process and checks first-time setup with a password, through both the source CLI and `swiftstream.exe` (it needs a POSIX `sh`, such as Git Bash on Windows).

## Roadmap

1. **Publish to npm and GitHub Releases**: `swiftstream.exe` and the app installer, signed.
2. **Delta transfer** for large files that changed slightly (rsync-style rolling checksums), and an optional `--delete` for folder sync.
3. **HTTP/3 / QUIC transport** for lossy links, keeping HTTPS/1.1 as the fallback.
4. **Accounts** (Termius-style): a hosted account that syncs your host list and public keys between devices. The private key stays on each device.
5. **Desktop app polish**: multiple terminal tabs per server, delete/rename in the file browser, auto-update, and signed builds for Windows and macOS.
6. **Hardening**: rate-limit auth, per-key permissions such as a root dir or read-only access, audit log, and systemd/launchd service install.
7. **Port forwarding** over the same WebSocket channel.
