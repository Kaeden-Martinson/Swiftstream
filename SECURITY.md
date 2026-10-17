# Security policy

## Reporting a vulnerability

Please don't open a public issue for security problems. Report them privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Include what's affected, how to reproduce it, and the impact you expect.

You'll get a reply within a few days. Once a fix is released, the report and its fix are published as a security advisory, with credit to you unless you'd rather not.

## Supported versions

Fixes go into the latest release. The app updates itself and updates the servers it connects to, so staying current is automatic for most people.

## What counts

Anything that lets someone without an authorized key run commands or read and write files on a server; that breaks certificate pinning; that leaks keys, passwords or passphrases; or that lets a malicious server write outside the folder you chose on your computer. Missing hardening is welcome too, as a normal issue.
