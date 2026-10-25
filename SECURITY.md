# Security policy

## Supported versions

Security fixes are made for the latest release and the `main` branch. Older
releases are not updated; please upgrade to the latest release.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/aoe2control/AoE2RMSIDE/security/advisories/new)
for this repository. Do not open a public issue, pull request, or discussion
for a vulnerability.

Include as much of the following as you can:

- the affected version or commit;
- what an attacker could do, and under which conditions;
- the steps or a minimal file that reproduces the problem;
- a suggested fix or mitigation, if you have one.

Do not include personal data, credentials, or files you do not have the right
to share. Remove local paths and user names from logs before you attach them.

You will get an acknowledgement as soon as possible, usually within a week.
The report is reproduced and fixed privately, and the fix is released before
the details are made public. You are credited in the release notes if you
wish.

## Scope

Examples of what is in scope:

- a script, include, XS file, map test, or other file that makes the application or
  one of its native executables run code, read or write files outside what
  the user opened or authorized, or exhaust memory or disk without a bound;
- a way for the renderer process to reach Node.js, the file system, or child
  processes;
- a way to make the application write into the game installation, or into a
  file in the user's game profile that the application did not create;
- a way to start a live test in a multiplayer match;
- a way for a program to use the MCP connection without the user allowing
  it, or for an allowed AI app to read or write files outside the open
  folder, save while **Let AI apps save files** is off, replace a mod it did
  not deploy, or start a live test without the user's confirmation;
- a way to make the in-app update run a file other than the installer of an
  AoE2RMSIDE release published in this repository.

Issues in the game itself, in AoE2Control, or in third-party dependencies
should be reported to their own maintainers; tell us as well if AoE2RMSIDE is
affected.

## How the application protects you

- The interface runs in sandboxed renderer processes without direct Node.js,
  file system, or child process access. Every request goes through a typed
  bridge that the main process validates.
- The packaged executable refuses to run as plain Node.js, ignores
  `NODE_OPTIONS` and the Node.js inspector options, and loads only its own
  application archive after checking that archive's integrity.
- The native executables accept only bounded, versioned messages and refuse
  unsupported versions instead of guessing.
- MCP, the connection for AI apps, is off until the user turns on **Enable
  MCP**. It is a named pipe on the user's computer, not a network server,
  and only a program that can read its key in the user's settings folder can
  open it. The relay `rms-connect.exe` that AI apps start connects only to
  the AoE2RMSIDE installation it belongs to. Each AI app is allowed once in
  a prompt; the name it shows is the name the app gives itself, so allowing
  an app is consent, not protection against other programs running as the
  same user. Allowed apps work only in the open folder and can switch it to
  one of the user's recent folders, never to a game or mod folder; replacing
  a mod they did not deploy and starting a live test ask the user first.
- The application has no telemetry and no automatic crash upload. Logs stay
  on the user's computer unless the user chooses to share them.
- At startup the main process makes one request to GitHub to check for a
  newer release of this repository. It sends no credentials, paths, scripts,
  or machine identifiers. The check can be turned off under Help, **Check for
  New Versions at Startup**.
- Nothing is downloaded unless the user chooses **Update**, which only the
  installed version offers. The application then downloads that release's
  installer and checksum list from this repository's releases over HTTPS,
  runs the installer only if it matches the published checksum, and deletes
  the download if it does not. The checksum shows that the file arrived
  intact; it does not prove who published it, because the downloads are not
  code-signed.
