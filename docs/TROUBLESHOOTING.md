# Troubleshooting and FAQ

If something here doesn't fix it, [open an issue](https://github.com/Kaeden-Martinson/Swiftstream/issues/new/choose). In the app, **Settings › Help › Copy diagnostics** copies what we need to know: versions, your servers and their status, and the recent log. It never includes passwords or keys.

## Setting up a server

**"No SSH server is answering" or "Connecting timed out"**
Check the address and the SSH port: `ssh user@host` in a terminal should work first. Swiftstream uses the same login.

**Setup works, but connecting afterwards fails with "Couldn't connect … swiftstream isn't running there"**
Swiftstream listens on port **7022** (change it with `--port`). The server's firewall, or your cloud provider's security group, has to allow it:

```bash
sudo ufw allow 7022/tcp
```

On AWS, Google Cloud, Azure, OVH and similar, also allow TCP 7022 in the server's network rules.

**Setup says "Port 443 … is used by another program" or "needs permission"**
Swiftstream also listens on 443 and 8443 so networks that block 7022 (school, work and public Wi-Fi) can still reach it. If a website already uses 443, Swiftstream uses 8443, which most of those networks also allow. To use 443 as well, share it (below). For "needs permission", run the `sudo setcap …` line setup printed on the server, then connect again: it lets Swiftstream's own copy of Node.js (nothing else) use ports below 1024.

### Sharing port 443 with a website

Swiftstream can take port 443 and pass every connection that isn't its own on to your website, untouched and still encrypted. Each TLS connection starts by naming the server it wants (SNI): Swiftstream's clients name `swiftstream`, browsers name your site's domain, so the two never mix. Your website keeps its certificate and its visitors; nothing is decrypted on the way.

1. Move the website off 443 to a local port, for example `127.0.0.1:8444`. With nginx, change `listen 443 ssl;` to `listen 127.0.0.1:8444 ssl;` and reload. With Docker, publish `127.0.0.1:8444:443` instead of `443:443`. With Caddy, set `https_port 8444` in its global options.
2. From your computer, on a network where SSH works:
   ```bash
   swiftstream deploy <name> <user@host> --share-with 127.0.0.1:8444
   ```
   Swiftstream starts listening on 443 and forwards everything else to 8444. The setting is saved on the server (`~/.swiftstream/serve.json`), so updates, repairs and reboots keep it.
3. Check the website still loads in a browser.

Things to know: while sharing, the website is only reachable on 443 when Swiftstream is running (it restarts on boot from cron, and the app restarts it if it stops). The website sees visitors as coming from `127.0.0.1`, so its logs and any per-visitor limits lose their real addresses. To stop sharing, run the same command with `--share-with off`, then move the website back to 443.

If you'd rather your own proxy does the routing, any proxy that routes TLS by SNI without decrypting works: nginx's `stream` module with `ssl_preread on` (send `$ssl_preread_server_name` `swiftstream` to `127.0.0.1:7022`), HAProxy with `req.ssl_sni`, or a Traefik TCP router with `` HostSNI(`swiftstream`) `` and `passthrough: true`.

**"SSH host key has changed"**
The server's SSH identity is different from the first time you connected. That's expected after reinstalling a server, and suspicious otherwise. If you reinstalled it, remove its line from `~/.swiftstream/ssh_known_hosts.json` and set it up again.

**"Can't reach … from this network: Swiftstream (port 7022) and SSH (port 22) both don't answer"**
Swiftstream is probably running fine, and this network blocks both ports. Servers set up with 0.1.6 or newer also listen on 443, which these networks allow, so this only happens where 443 couldn't be added (see above), or before a server was updated. School, work and public Wi-Fi often allow only web ports (80 and 443), and some refuse other ports outright, which looks the same as a stopped server. To check whether Swiftstream answers, open `https://<server>:7022/swiftstream-health` in a browser (accept the certificate warning): `{"ok":true,...}` means it's up and the network was the problem. A phone hotspot or VPN gets through.

**"Can't reach SSH on … from here"**
Swiftstream repairs a server over SSH when HTTPS fails, and this network doesn't let SSH through (school, work and public Wi-Fi often block it). Swiftstream itself only needs HTTPS: once the server is running it works here. To set it up or repair it, use another network, such as a phone hotspot.

**It asks for a password even though I use an SSH key**
Swiftstream tries your SSH agent, the key named by `IdentityFile` in `~/.ssh/config`, and `~/.ssh/id_ed25519`, `id_ecdsa` and `id_rsa`. A key with a passphrase is asked about at the keyboard (in the app, a dialog). If none of them is accepted by the server, the account's password is next. On Windows, start the **OpenSSH Authentication Agent** service to use keys loaded with `ssh-add`.

**The server has no Node.js**
Setup installs it into `~/.swiftstream/runtime`, without root. That needs `curl` or `wget` and internet access on the server. On systems the official Node.js builds don't support (Alpine and other musl-based ones), it uses the system's package manager instead, with `sudo` and the login password.

## Using it

**"swiftstream" isn't recognized after installing the app**
Open a new terminal: windows that were already open keep the old PATH. `where.exe swiftstream` shows which copy runs (the app's, or one from `npm i -g swiftstream`; both work).

**The terminal says "Basic terminal: full-screen programs like vim won't work"**
The server has neither `node-pty` nor the `script` command. On Linux, install `util-linux` (it provides `script`). The Void Linux installer sets up `node-pty`.

**No colors in the terminal**
Servers set up before 0.1.1 hid them. Connecting with a current app or CLI updates the server, and new terminals have colors.

**A transfer is slow or stuck**
Pause it and resume: it continues from what already arrived. Files are checked with SHA-256 at the end, so nothing corrupt is ever kept. From the command line, `--parallel` changes how many connections are used (default 8).

**"This computer's key isn't authorized"**
The server doesn't know this computer. Set the server up again over SSH (it authorizes the key), or run the `swiftstream authorize` line from the error on the server. **Authorized computers…** (right-click a server) shows who can log in.

**Windows says "Windows protected your PC"**
The installer isn't code-signed yet. Choose **More info › Run anyway**. Every download's SHA-256 is listed on the download page, so you can check it with `certutil -hashfile <file> SHA256`.

**macOS says the app "can't be opened" or "is damaged"**
The Mac app isn't notarized by Apple yet. The first time, right-click Swiftstream in Applications and choose **Open**, then **Open** again. If macOS says it's damaged, run `xattr -cr /Applications/Swiftstream.app` in Terminal once.

**The Linux AppImage doesn't start**
Make it executable first (`chmod +x Swiftstream-*.AppImage`). On Ubuntu 22.04 and newer, AppImages also need FUSE 2: `sudo apt install libfuse2`. Or use the .deb instead.

**The app doesn't update itself**
Updates are off when running from source, and on macOS until the Mac build is signed (download new versions from the website there). Otherwise **Settings › Updates** shows the last check; the log (**Settings › Help › Open folder**) says why a check failed.

## FAQ

**Do servers update themselves?** Only with automatic updates on (`swiftstream auto-update <name> on`, or the server's right-click menu in the app); otherwise a server is updated when you connect to it from a network where SSH works. With them on, it checks every 6 hours and restarts on a new version once nobody is using it. `~/.swiftstream/server.log` on the server says what it found and did.

**Does it replace SSH?** No. It uses SSH once to set itself up (and again to restart itself if it stops). Day to day, shells and transfers go over its own HTTPS connection, which is what makes transfers fast and resumable.

**What does it install on my server?** One file, `~/.swiftstream/bin/swiftstream.cjs`, plus Node.js in `~/.swiftstream/runtime` if the server didn't have it, and an `@reboot` line in your crontab. It runs as your user, never as root unless you log in as root.

**How do I remove it from a server?** On the server, run `~/.swiftstream/runtime/bin/node ~/.swiftstream/bin/swiftstream.cjs stop` (or `node …` if Node.js was already there), delete `~/.swiftstream`, and remove the `swiftstream` line from `crontab -e`. Then remove the server in the app or with `swiftstream remove <name>`.

**Where is my data on this computer?** `~/.swiftstream`: your key (`id_ed25519`), saved servers (`hosts.json`), app settings and the log. Passwords and passphrases are never stored.

**Is it secure?** Each server has its own certificate, pinned on first contact like an SSH host key. Logins use an Ed25519 key that never leaves your computer, repeated failed logins are blocked, and everything travels over TLS. See [Security model](../README.md#security-model).
