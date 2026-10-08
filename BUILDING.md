# Building AoE2RMSIDE

This guide builds AoE2RMSIDE from source on Windows, step by step. You do not
need Age of Empires II or any other repository. The first build downloads
dependencies and takes several minutes; later builds are faster.

## 1. Check your system

- Windows 10 or Windows 11, 64-bit (x64).
- About 15 GB of free disk space: most of it for the Visual Studio Build
  Tools, and about 4 GB for the project folder after a full build.
- An internet connection for the first install.

## 2. Install the tools

Install each tool once. Node.js and pnpm are pinned: use exactly these
versions. Rust is pinned by the repository itself (step 3).

| Tool                                            | Version             | Notes                                                         |
| ----------------------------------------------- | ------------------- | ------------------------------------------------------------- |
| [Git](https://git-scm.com/download/win)         | any recent          | Keep the default line ending option (checkout Windows-style). |
| Visual Studio Build Tools                       | 2022 or later       | Select the **Desktop development with C++** workload.         |
| [rustup](https://rustup.rs/)                    | any recent          | Installs Rust; the project selects Rust 1.97.1 itself.        |
| [Node.js](https://nodejs.org/)                  | 24.12.0             | The x64 Windows installer.                                    |
| [pnpm](https://pnpm.io/installation)            | 11.19.0             | See below.                                                    |
| [PowerShell](https://aka.ms/powershell)         | 7 or later (`pwsh`) | Used by the packaging step.                                   |
| [Inno Setup](https://jrsoftware.org/isinfo.php) | 6.7.3               | Only for the installer (step 6).                              |

The Visual Studio Build Tools provide the C++ linker that Rust needs on
Windows. In the Visual Studio Installer, choose **Desktop development with
C++** and keep its default components (MSVC and a Windows SDK).

Install pnpm after Node.js, in a new terminal:

```powershell
npm install --global pnpm@11.19.0
```

You do not need to install Protobuf, `protoc`, or `buf` yourself. The Rust
build uses a bundled `protoc`, and the generated TypeScript bindings are part
of the repository.

Open a new PowerShell window and check the versions:

```powershell
git --version
node --version     # v24.12.0
pnpm --version     # 11.19.0
rustup --version
pwsh --version
```

## 3. Get the source

```powershell
git clone https://github.com/aoe2control/AoE2RMSIDE.git
cd AoE2RMSIDE
```

Install the Rust toolchain this folder asks for (Rust 1.97.1 with `clippy`
and `rustfmt`, as `rust-toolchain.toml` requests):

```powershell
rustup toolchain install
```

## 4. Install the dependencies

```powershell
pnpm install --frozen-lockfile
```

This installs the exact JavaScript dependencies from `pnpm-lock.yaml`,
including Electron.

## 5. Build and package the application

```powershell
pnpm package:zip
```

This builds the desktop application, builds the native executables (`rmsd`,
`rms-ls`, `rms-test`) in release mode, writes the license notices of every
third-party component into the package (`resources\THIRD-PARTY-NOTICES.txt`),
packages everything with Electron Forge, and writes the portable ZIP with its
SHA-256 checksum and build information:

```text
artifacts\packages\AoE2RMSIDE-<version>-win32-x64.zip
artifacts\packages\AoE2RMSIDE-<version>-win32-x64.zip.sha256
artifacts\packages\AoE2RMSIDE-<version>-win32-x64.build.json
```

The unpacked application is also left in:

```text
apps\desktop\out-full\AoE2RMSIDE-win32-x64\AoE2RMSIDE.exe
```

Start `AoE2RMSIDE.exe` from that folder, or unpack the ZIP anywhere. The
folder is self-contained. Close the application before you package again.

`pnpm package` builds only the unpacked application, into
`apps\desktop\out\AoE2RMSIDE-win32-x64`, without the ZIP.

## 6. Build the installer (optional)

The installer is built with **Inno Setup 6.7.3**. Install it once, for your
user account:

```powershell
winget install --id JRSoftware.InnoSetup --version 6.7.3 --scope user
```

Then build the ZIP first (step 5) and the installer from the same package:

```powershell
pnpm package:zip
pnpm package:installer
```

The installer lands beside the ZIP:

```text
artifacts\packages\AoE2RMSIDE-<version>-win32-x64-setup.exe
artifacts\packages\AoE2RMSIDE-<version>-win32-x64-setup.exe.sha256
artifacts\packages\AoE2RMSIDE-<version>-win32-x64-setup.build.json
```

The packaging step looks for `ISCC.exe` in your user's Inno Setup folder,
then in the Program Files folders. If you installed it somewhere else, set
`RMSIDE_ISCC` to the full path of `ISCC.exe`. It refuses other Inno Setup
versions.

The installer installs for the current user only, without administrator
rights, into `%LOCALAPPDATA%\Programs\AoE2RMSIDE`. It offers AoE2RMSIDE in
Windows' **Open with** list for `.rms` and `.rms2` files and adds an **Open
folder in AoE2RMSIDE** action to folders. Uninstalling removes the
application and this registration, and keeps your settings and files. To
remove the settings as well, delete the `%APPDATA%\@rmside\desktop` folder
after uninstalling (the editor previews keep theirs in `%APPDATA%` folders
named after them).

## 7. Build the editor previews (optional)

The XS Editor Preview and the RMS Editor Preview are smaller editions with
only the editor and its language support. Each keeps its settings separate
from the full application.

```powershell
pnpm package:xs-preview
pnpm package:rms-preview
```

Each writes its own ZIP into `artifacts\packages`
(`AoE2RMSIDE-XS-Editor-Preview-<version>-win32-x64.zip` and
`AoE2RMSIDE-RMS-Editor-Preview-<version>-win32-x64.zip`) and leaves the
unpacked application in `apps\desktop\out-xs-preview` or
`apps\desktop\out-rms-preview`.

## 8. Check a change (for contributors)

```powershell
pnpm format:check
pnpm lint
pnpm build
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for what to check by hand and how to
describe it in a pull request.

## Common problems

**`linker 'link.exe' not found` or `link: extra operand` during the Rust
build.** The Visual Studio C++ build tools are missing, or another `link`
program comes first on your `PATH` (for example from Git's Unix tools). Install
the **Desktop development with C++** workload and build from a normal
PowerShell window.

**`pnpm` is not found, or reports a different version.** Install it with
`npm install --global pnpm@11.19.0` and open a new terminal.

**`pnpm install` fails while downloading Electron.** A firewall or proxy
blocked the download. Run `pnpm install --frozen-lockfile` again on a working
connection.

**`ERR_PNPM_OUTDATED_LOCKFILE` or the lockfile would change.** You changed a
`package.json`. Restore it, or run `pnpm install` without `--frozen-lockfile`
if you meant to change dependencies.

**`pnpm format:check` reports every file.** Your clone has Unix line endings.
Re-clone with Git's default Windows setting (`git config --global core.autocrlf
true`).

**`Release native executable is missing`.** The native build did not finish.
Run `pnpm package:zip` again and look for the first Rust error above that
message.

**`The installer needs the Inno Setup 6.7.3 compiler`.** Inno Setup is not
installed, or not where the packaging step looks. Install it as in step 6,
or set `RMSIDE_ISCC` to the full path of `ISCC.exe`.

**`... is not a packaged AoE2RMSIDE edition with build metadata`.** Run
`pnpm package:zip` before `pnpm package:installer`.

**Packaging fails with `EBUSY` or `EPERM`.** The packaged application, or a
file in its folder, is still open. Close AoE2RMSIDE and any Explorer window on
the output folder, then package again.

**Windows SmartScreen or antivirus warns about `AoE2RMSIDE.exe`.** Builds are
not code-signed. A build you made yourself is safe to allow.
