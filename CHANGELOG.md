# Changelog

What changed in each version. The release workflow copies a version's section into its GitHub Release.

## [Unreleased]

- Installing the desktop app puts the `swiftstream` (and `sws`) command on your PATH, with no Node.js needed.
- `swiftstream app` opens the desktop app, or brings it to the front if it's already open.
- A pinned taskbar button keeps the Swiftstream name and logo.
- The installer always makes sure the desktop shortcut is there, updates included.
- The desktop app updates itself: new versions download in the background, then "Restart to update".

## [0.1.1] - 2026-10-16

- Light and dark themes in the desktop app (Settings › Appearance) and on the website.
- The window buttons sit on the tab bar; the separate title bar is gone.
- Select several files with a box: drag across rows. Drag toward the other pane to move them.
- Terminals show colors again: shells no longer inherit `NO_COLOR` from the server.

## [0.1.0] - 2026-10-16

- First release as Swiftstream (formerly SwiftSSH): command line, desktop app for Windows, and the server.
