# Changelog

What changed in each version. The release workflow copies a version's section into its GitHub Release.

## [Unreleased]

## [0.1.10] - 2026-10-26

- Fixed: in the desktop app, uploading or downloading a folder with an `.asar` file in it (like an Electron app's `resources/app.asar`) failed with "ENOENT, not found in …app.asar". Electron opens `.asar` files as folders; transfers now use its plain file functions.

## [0.1.9] - 2026-10-22

- Servers can update themselves (opt-in): `swiftstream auto-update <name> on`, or **Turn on automatic updates** in the app's server menu. The server checks GitHub Releases every 6 hours, verifies a newer version against the release's checksums and that it runs, and restarts on it once nobody is using it, putting the previous version back if the new one doesn't start. The setting works over HTTPS, so it can be changed from networks that block SSH.

## [0.1.8] - 2026-10-22

- Servers also listen on port 8443, tried after 443. Many networks that block 7022 allow it, and it needs no special permission, so it also covers servers where a website holds 443.
- Swiftstream can share port 443 with a website (`deploy … --share-with 127.0.0.1:8444`): it keeps the connections that name it (SNI) and passes every other one on to the website, still encrypted. The setting is kept on the server across updates, repairs and reboots. See "Sharing port 443" in the troubleshooting guide.
- On a network that blocks SSH, the command line no longer spends 10 seconds trying to update a server on every command: after SSH doesn't answer, it waits 15 minutes before trying again.
- `swiftstream stop` waits for the server to finish stopping.

## [0.1.7] - 2026-10-22

- Port 443 also works where Swiftstream ran on the server's system Node.js as a regular user: setup installs Swiftstream's own Node.js and gives only that copy permission for port 443 (with sudo). The system's Node.js is never changed.
- Fixed: the desktop app run from source could install an older Swiftstream on servers ("it still reports 0.1.5 after updating"). It now builds the server program from the checkout, however it was started.
- Updating a server says why port 443 couldn't be added there, as setup does.

## [0.1.6] - 2026-10-21

- Swiftstream gets through networks that only allow web ports (school, work and public Wi-Fi often block 7022). Setup, and the next update or repair, also opens Swiftstream on port 443, and the app and the command line switch to it when 7022 doesn't answer. As root it just works; for another Linux user, Swiftstream's own Node.js is given permission for port 443 with sudo (`setcap cap_net_bind_service`). If 443 is taken by a web server, or permission can't be given, setup says so and why. `--web-port` picks another port; `--web-port 0` turns it off.
- Servers answer a public health check at `/swiftstream-health` (no login; says only that Swiftstream is up and its version). Before logging in over SSH to repair a server that didn't answer, the app and the command line ask it once more: if Swiftstream answers, they just connect again.
- When neither Swiftstream nor SSH answers, the message says the network is probably blocking them (school and work Wi-Fi often do) and that Swiftstream is likely still running, instead of "Swiftstream isn't running".
- A server running an older Swiftstream is updated as soon as you log in to it, from the app or any command line command, and you're told which version it was updated to (for example "Updated Swiftstream on prod from 0.1.4 to 0.1.6"). The command line skips this when `SWIFTSTREAM_NO_SERVER_UPDATE=1` is set.
- Fixed: the desktop app run from source could "update" servers to an older build every half hour. `npm start` now rebuilds the server program first, and an update that leaves the old version in place is reported once instead of repeated.

## [0.1.5] - 2026-10-19

- Reconnecting repairs the server: HTTPS is tried first, and if it fails in a way SSH can fix, the app and the command line log in over SSH with this computer's key, find what's wrong and fix it, then carry on. That covers a stopped or stuck Swiftstream, a deleted program file, a removed Node.js, an older version, this computer's key no longer being accepted, and a new certificate (taken only from the SSH login, whose host key is already known). It says what it fixed. This happens when opening a terminal, a folder or a transfer, and on every command line command, not just in the background check.
- Where SSH is blocked (common on school and work Wi-Fi), a repair gives up after 10 seconds and says so, instead of hanging.
- A computer that was just authorized again on a server is no longer locked out by earlier failed logins.

## [0.1.4] - 2026-10-18

- Maintenance release: the release process publishes to npm on its own. No changes to the app or the command line.

## [0.1.3] - 2026-10-18

- Rearrange tabs by dragging them. Tab bar from the keyboard: after clicking a tab (or tabbing to it), the arrow keys and Home and End switch tabs, Delete closes the focused one, and Enter, Escape or typing in a terminal tab goes back into it. Ctrl+PageUp and Ctrl+PageDown switch tabs from anywhere.
- The tab bar shows a focus outline when you move through it with the Tab key, and none when you switch tabs with the arrow keys.

## [0.1.2] - 2026-10-17

- Installing the desktop app puts the `swiftstream` (and `sws`) command on your PATH, with no Node.js needed.
- `swiftstream app` opens the desktop app, or brings it to the front if it's already open.
- A pinned taskbar button keeps the Swiftstream name and logo.
- The installer always makes sure the desktop shortcut is there, updates included.
- The desktop app updates itself: new versions download in the background, then "Restart to update".
- Servers running an older Swiftstream are updated automatically: by the app (once their terminals are closed) and by `swiftstream connect`, with this computer's key.
- Servers from `~/.ssh/config`: the app lists them under "From your SSH config", `swiftstream import` sets them up, and `swiftstream connect <alias>` works like `ssh <alias>`. Setup uses the host's IdentityFile and the Windows OpenSSH agent.
- Transfers can be paused, resumed and canceled; the cards show live speed and time left, and the Transfers button on the tab bar lists recent transfers with Retry. Downloads now resume too (in the app and with `swiftstream pull`), and canceling removes partial files, on the server as well.
- Terminal: find (Ctrl+Shift+F), text size (Ctrl+= / Ctrl+− / Ctrl+0, also in Settings), copy on select (Settings), a right-click menu with Copy, Paste, Find, Split and Clear, and split panes: several terminals side by side in one tab (Ctrl+Shift+D, Ctrl+Shift+W closes one).
- SSH keys with a passphrase work for setup: the app shows a dialog for it and the CLI asks at the keyboard (Enter skips to the password). Passphrases are never saved.
- See and remove the computers allowed to log in to a server: right-click it › Authorized computers…, or `swiftstream computers` and `swiftstream revoke`. Setup now saves each computer's name (user@computer) with its key.
- Desktop app for macOS (Apple silicon and Intel) and Linux (AppImage and .deb), with ⌘ shortcuts, Finder and Trash wording and macOS editors on a Mac. Standalone command line downloads for macOS and Linux too.
- Settings › Help: Copy diagnostics (versions, servers and status, recent log; no passwords or keys) for bug reports, Open log folder, and Report a problem. The app keeps a small log in ~/.swiftstream/logs.

## [0.1.1] - 2026-10-16

- Light and dark themes in the desktop app (Settings › Appearance) and on the website.
- The window buttons sit on the tab bar; the separate title bar is gone.
- Select several files with a box: drag across rows. Drag toward the other pane to move them.
- Terminals show colors again: shells no longer inherit `NO_COLOR` from the server.

## [0.1.0] - 2026-10-16

- First release as Swiftstream (formerly SwiftSSH): command line, desktop app for Windows, and the server.
