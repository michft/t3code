# Install the JJ fork Nightly

The `michft/t3code` prereleases provide unsigned macOS builds based on an identified upstream T3
Code Nightly plus the JJ/Git compatibility changes.

Use the installer matching the Mac:

- Apple Silicon: `T3-Code-JJ-*-arm64.dmg`
- Intel: `T3-Code-JJ-*-x64.dmg`

The fork installs as **T3 Code (JJ Nightly)**. It has a separate bundle ID, reads and writes
`~/.t3-jj`, and checks `michft/t3code` for updates. It does not share state or updates with official
**T3 Code (Nightly)**, which continues to use `~/.t3`.

Before installing, verify the DMG against `SHA256SUMS.txt`. `release-info.json` records the exact
fork commit, upstream Nightly commit, bundle identity, and state directory.

Because the build is unsigned, first launch may require right-clicking the app and choosing
**Open**, or approving it under **System Settings → Privacy & Security**.

## Clean release procedure

1. Merge the JJ feature line onto the exact upstream Nightly commit recorded in
   `.github/workflows/fork-desktop-release.yml`.
2. Keep all JJ work in migration IDs newer than upstream. Migration 35 repairs databases made by
   the old fork that used migration ID 33.
3. Push the clean commit to `michft/t3code`.
4. Run **Fork Desktop Release** manually with a new Nightly version, or push a matching
   `fork-v<version>` tag.
5. Confirm the workflow's identity verification passes before installing the DMG.

Never replace official Nightly in place. Keep both apps installed under their distinct names.
