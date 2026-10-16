# Testing Swiftstream end to end

Use this before each release. The automated tests cover the protocol, setup over SSH and the npm package. Everything below them is what only a real server, a real desktop and a real browser can show.

**You'll need:**

- **Windows PC:** this one.
- **Linux server you can SSH into:** your VPS works. A second, throwaway VPS is better for the "fresh server" tests.
- **Void Linux server (optional):** for the runit service and the website.
- **Domain:** pointed at the server that will host the website.

## 1. Automated

```bash
npm test
```

```bash
npm run test:package
```

- [ ] `npm test`: 13 protocol tests, plus 7 SSH setup tests against an in-process SSH server.
- [ ] `npm run test:package`: packs the npm tarball, installs it like `npm i -g`, and runs the setup tests with that copy.

## 2. Command line from npm

Before publishing, install the tarball the same way users will:

```bash
npm pack
```

```bash
npm i -g ./swiftstream-0.1.0.tgz
```

After publishing, use `npm i -g swiftstream` instead.

- [ ] `swiftstream --version` and `sws --version` print the version.
- [ ] `swiftstream` on its own shows the welcome and the command list.
- [ ] **First connect:** `swiftstream connect user@your-server`
  - asks you to confirm the server's SSH fingerprint;
  - asks for the password without showing what you type;
  - shows "Uploading", then "Starting";
  - opens a shell.
- [ ] **In that shell:** `vim`, `htop` and Ctrl+C work.
- [ ] **Saved name:** `exit`, then `swiftstream connect <name>` reconnects with no password.
- [ ] **Exec:** `swiftstream exec <name> -- uname -a` prints the server's details.
- [ ] **Upload a file:** `swiftstream push <name> ./bigfile.iso ~/` shows a progress bar and ends with "verified".
- [ ] **Resume:** press Ctrl+C halfway through a large push. Run the same command again; it says "resuming" and finishes.
- [ ] **Folder sync:** `swiftstream push <name> ./some-folder ~/`. Run it again: "0 sent, N unchanged".
- [ ] **Download:** `swiftstream pull <name> ~/some-folder ./`.
- [ ] **Speed:** `swiftstream bench <name>` prints scp versus Swiftstream timings. Keep the numbers for the website.
- [ ] **Errors read as plain English:**
  - a typo: `swiftstream conect` suggests `connect`;
  - a wrong password;
  - a server that's switched off.
- [ ] **Firewall:** with port 7022 blocked on the server, setup explains how to open it.
- [ ] **Fresh server:** on a server without Node.js, first connect installs Node.js into `~/.swiftstream/runtime`.

## 3. Standalone executable

- [ ] Copy `swiftstream-<version>-win-x64.exe` (from the website or `site/downloads`) to a PC without Node.js. `.\swiftstream-<version>-win-x64.exe connect user@server` works the same as above.
- [ ] Windows SmartScreen may warn, because the file isn't signed yet. Note what it says.

## 4. Desktop app

Install `Swiftstream-Setup-<version>.exe`. Uninstall the old SwiftSSH app first if it's there.

**Servers and tabs**

- [ ] **Your existing servers:** they appear, carried over from `~/.swiftssh` or the CLI.
- [ ] **New server:** type `user@host` in the search bar and press **Connect**. Enter the password and watch the steps; it opens a terminal tab.
- [ ] **New-tab menu:** **+** (or Ctrl+T) lists servers with **Terminal** and **Files**. Open two terminals and one file browser for the same server.
- [ ] **Tab keys:** Ctrl+Tab cycles through tabs and Ctrl+W closes one.
- [ ] **Restart memory:** after quitting and reopening, the same tabs come back.
- [ ] **Editing:** from the Servers page, edit a server. Rename it and set a group; the tabs and remembered folders follow.

**Files**

- [ ] **Drag in from Explorer:** files go to the server folder that's open.
- [ ] **Between panes:** drag left to right uploads, and right to left downloads.
- [ ] **Remembered spot:** upload from the same local folder to a different server folder. Next time, the app offers the remembered spot, and **Go there** works.
- [ ] **Navigation:** back, forward and up, in the buttons, mouse side buttons, Alt+Left/Right and Backspace.
- [ ] **Filter and path:** Ctrl+F filters, and clicking the path bar (or Ctrl+L) lets you type a path.
- [ ] **Right-click menu:** rename (F2), delete (Del; asks first on a server), new folder, copy path.
- [ ] **Open and save back:**
  - Double-click a text file on the server; it opens in your default editor.
  - Edit and save it; a toast says it was saved, and the file on the server has changed.
  - **Open with VS Code** and **Open with Notepad** work.
- [ ] **Transfer cards:** they disappear about a second after finishing. Failed ones stay longer.

**Health and settings**

- [ ] **Stopped program:** on the server, run `pkill -f swiftstream.cjs`. Within one check interval, the app shows "Restarting…" and the terminal reconnects by itself.
- [ ] **Reboot:** after `sudo reboot`, Swiftstream comes back by itself (crontab `@reboot`), or the app restarts it.
- [ ] **Turning it off:** with auto-restart switched off in Settings, a stopped server shows the red banner with **Start server again**.
- [ ] **Actions:** add a right-click action in Settings (for example `sudo systemctl restart nginx` on a server), then run it from a server card.
- [ ] **Closing:** Settings closes with **X** or Esc, back to the tab you were on.

## 5. Server on Void Linux

- [ ] `sudo sh deploy/void/install.sh --user <you>` finishes and prints a fingerprint.
- [ ] `sv status swiftstream` shows it running.
- [ ] `tail /var/log/swiftstream/current` shows the logs.
- [ ] **Survives a reboot:** after `sudo reboot`, `sv status swiftstream` shows it up again.
- [ ] **Upgrade:** re-running the script upgrades it. On a machine that had the old `swiftssh` service, that service is removed.

## 6. Website

```bash
npm run release
```

```bash
npm run publish-site -- <server>
```

- [ ] **Downloads:** the page shows the right version, sizes and checksums, and each **Download** button saves a file instead of displaying it.
- [ ] **Checksum:** on Windows, `certutil -hashfile <file> SHA256` matches the checksum on the page.
- [ ] **Animations:** the hero skeleton resolves, the upload demo loops, the terminal types itself out, and the app tabs switch.
- [ ] **Phone size:** the menu button opens the menu, and nothing scrolls sideways.
- [ ] **404:** a made-up path shows the 404 page.
- [ ] **Security headers:** `curl -I https://<domain>/` shows them, and `curl -I https://<domain>/downloads/latest.json` isn't cached.
- [ ] **Download test:** on another PC, download the installer from the site and go through section 4 quickly.
