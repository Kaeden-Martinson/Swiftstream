# Changelog

What changed in each version. The release workflow copies a version's section into its GitHub Release.

## [Unreleased]

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
