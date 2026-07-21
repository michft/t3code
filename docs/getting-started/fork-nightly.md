# Install the michft fork nightly

The [michft/t3code releases page](https://github.com/michft/t3code/releases) provides unsigned community builds based on an identified upstream `pingdotgg/t3code` nightly plus fork changes.

Choose the installer for your platform:

- Apple Silicon Mac: `T3-Code-*-arm64.dmg`
- Intel Mac: `T3-Code-*-x64.dmg`
- Windows x64: `T3-Code-*-x64.exe`
- Linux x64: `T3-Code-*-x86_64.AppImage`

Files ending in `.yml`, `.blockmap`, and `.zip` support desktop updates. `SHA256SUMS.txt` verifies downloads. `release-info.json` records the exact fork and upstream commits used by the build.

## Before first use

Install and authenticate at least one supported provider CLI:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.
- Claude: install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.
- Cursor: install [Cursor CLI](https://cursor.com/cli), then run `cursor-agent login`.
- OpenCode: install [OpenCode](https://opencode.ai), then run `opencode auth login`.

## macOS

Download the DMG matching the Mac processor. Do not execute the DMG in Terminal and do not use `chmod` on it. Double-click it in Finder, or run:

```sh
open T3-Code-*-arm64.dmg
```

Drag T3 Code into Applications. Because the fork is unsigned, first launch may require right-clicking the app and choosing **Open**, or approving it under **System Settings → Privacy & Security**. Native passkey sign-in is unavailable in unsigned builds.

## Windows

Download and run `T3-Code-*-x64.exe`. The unsigned installer may trigger Microsoft Defender SmartScreen. Confirm the file came from `michft/t3code`, verify its checksum, then choose **More info → Run anyway** if you accept the risk.

## Linux

```sh
chmod +x T3-Code-*-x86_64.AppImage
./T3-Code-*-x86_64.AppImage
```

Some distributions require FUSE for AppImage. If launch reports a FUSE error, install the distribution's AppImage/FUSE compatibility package or use the AppImage extraction option.

## Limitations and updates

These builds have no T3 signing credentials and do not contain ping.gg production relay or Clerk configuration. Local desktop and provider workflows work. T3 Connect sign-in and the managed relay do not.

The app checks `michft/t3code` for fork updates. Because signing identity is absent, automatic update behavior can be restricted by the operating system. A manual download from the releases page is always the fallback.

Verify a downloaded artifact against its line in `SHA256SUMS.txt`.

macOS:

```sh
grep 'T3-Code-.*\.dmg$' SHA256SUMS.txt | shasum -a 256 -c -
```

Linux:

```sh
grep 'T3-Code-.*\.AppImage$' SHA256SUMS.txt | sha256sum -c -
```

Windows PowerShell prints the file hash; compare it to the installer line in `SHA256SUMS.txt`:

```powershell
(Get-FileHash .\T3-Code-*-x64.exe -Algorithm SHA256).Hash.ToLower()
```

Report ordinary fork issues at [michft/t3code issues](https://github.com/michft/t3code/issues). Report fork-specific vulnerabilities through a [private security advisory](https://github.com/michft/t3code/security/advisories/new). Issues affecting upstream-operated code or services belong with upstream; security reports go to `security@ping.gg`.
