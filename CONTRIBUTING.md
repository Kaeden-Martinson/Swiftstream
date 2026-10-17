# Contributing

Thanks for helping. Bug reports, fixes and small features are all welcome; for something bigger, open an issue first so we can agree on the approach.

## Setup

You need Node.js 20 or newer, and on Windows, Git Bash (the tests use a POSIX `sh`).

```bash
npm install
```

```bash
npm install --prefix app
```

```bash
npm test
```

Run the desktop app from source with `npm run app`.

## Layout

- `src/`: the client, server and transfer code, shared by the CLI and the app.
- `bin/swiftstream.js`: the command line.
- `app/`: the Electron desktop app. `app/core` is a copy of `src/`, made by `npm run sync-core`.
- `site/`: the website. `test/`: protocol tests (`e2e.js`), SSH setup tests (`bootstrap.js`), and more.
- `docs/`: testing, releasing and troubleshooting guides.

## Pull requests

- Keep each one to one change, and add a test when you change behavior. `npm test` must pass; CI runs it on Linux, Windows and macOS.
- For the desktop app, `npm run test:app` drives the real app (see `test/app/`); add a `*.test.js` there for UI changes.
- Write user-facing text in plain words: say what happened and what to do next.
- Add a line under **Unreleased** in `CHANGELOG.md` for anything a user would notice.

Security problems: please follow [SECURITY.md](SECURITY.md) instead of opening an issue.
