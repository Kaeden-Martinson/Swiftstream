# Releasing Swiftstream

A release is a git tag. Pushing `v1.2.3` runs [.github/workflows/release.yml](../.github/workflows/release.yml), which:

1. checks the tag matches `package.json` and `app/package.json`, and runs the tests;
2. builds the installer, the standalone `swiftstream.exe` and the portable `swiftstream.cjs`, and attaches them to a GitHub Release with `SHA256SUMS.txt`, `latest.json` (the website's download list) and `latest.yml` (the desktop app's update feed);
3. publishes the npm package with provenance.

## Every release

1. Move the **Unreleased** notes in `CHANGELOG.md` under a new heading, e.g. `## [1.2.3] - 2026-11-02`.
2. Set the version in both packages:
   ```bash
   npm version 1.2.3 --no-git-tag-version
   ```
   ```bash
   npm version 1.2.3 --no-git-tag-version --prefix app
   ```
3. Commit, tag and push:
   ```bash
   git commit -am "Release 1.2.3"
   ```
   ```bash
   git tag v1.2.3
   ```
   ```bash
   git push origin main v1.2.3
   ```
4. Watch the **Release** run under the repository's Actions tab. When it's green, the GitHub Release and npm are live.
5. Update the website's downloads: download the release's files into `site/downloads/`, or run `npm run release` locally, then `npm run publish-site -- <server>`.

## One-time setup

**npm trusted publishing** (lets the workflow publish without a token or a two-factor code):

1. On npmjs.com, open the `swiftstream` package › **Settings** › **Trusted Publisher**.
2. Choose **GitHub Actions** and enter: owner `Kaeden-Martinson`, repository `Swiftstream`, workflow `release.yml`.
3. Save. Optionally set **Publishing access** to require two-factor authentication *and* disallow tokens, so only the workflow can publish.

**Code signing** (removes the SmartScreen warning) is not set up yet. Once there's a certificate or an Azure Trusted Signing account, add its secrets and electron-builder's `win.signtoolOptions` or `win.azureSignOptions`.
