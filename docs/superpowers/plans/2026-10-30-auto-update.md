# Installer Auto Update Implementation Plan

> For agentic workers: use subagent-driven-development to implement and review these bounded components; do not commit independently in the shared checkout.

Goal: deliver 1.1.1 as a per-user NSIS installer with automatic update checking/downloading and explicit safe restart, preserving existing user data.

Architecture: electron-updater 6.8.12 with electron-builder 26 NSIS, generic HTTPS feed at the existing Worker /updates/stable/. A dedicated RELEASES R2 bucket holds immutable installer/blockmap files and an atomically replaced latest.yml. A separate random RELEASE_PUBLISH_TOKEN secret authorizes publishing; ordinary admin and employee sessions do not. Images keep their separate seven-day bucket lifecycle.

## Contracts

- Native optional IPC: getUpdateState(), checkForUpdates(), installUpdate(), onUpdateStateChanged(callback).
- UpdateState: status idle/checking/available/downloading/ready/error/unsupported/installing; currentVersion string; version?, percent?, error?; busy boolean.
- Initial check after page load; repeat at most hourly; retries are manual or scheduled, without app-fatal rejection.
- autoInstallOnAppQuit=false. Installation reserves a native gate, refuses when uploads/hash/preparation are active, prepares renderer close, flushes manifest, then invokes quitAndInstall. A concurrent start is rejected while installing; failed persistence cancels install.
- Titlebar remains blue/white and works before login; current version, check/progress/ready button; install disabled while busy. Web clients hide this control.
- GET/HEAD /updates/:channel/:filename. Channels stable or acceptance-[a-z0-9-]+; filenames latest.yml or Yuntu-Workbench-Setup-X.Y.Z-x64.exe[.blockmap]. Latest no-store; immutable artifacts immutable caching; Range support for updater downloads.
- Publisher token header X-Release-Token; /api/releases/:channel/files/:filename PUT for small files; /api/releases/:channel/multipart/:filename POST start, PUT ?uploadId=&partNumber= for bounded 8MiB parts, POST /complete with {uploadId,parts}, DELETE with uploadId abort. Token compare fail closed. Stable executable files cannot overwrite existing objects. Publish manifest last only after referenced artifacts exist and size/hash metadata matches. No employee credentials in updater feed.

## Tasks

- [x] Native component: write failing tests for inactive/active install, concurrent starts, failed flush, duplicate checks, download errors; implement controller and main/preload integration; focused regression green.
- [x] Release backend: test public GET/HEAD/range, path restriction, missing/invalid publisher token, multipart, immutable artifacts, no early manifest; implement separate module and routing before normal JSON parse; no image retention changes.
- [x] UI component: test web/older preload fallback, checking/progress, ready while busy, error retry, stale subscriptions; implement optional typed APIs and titlebar control.
- [x] Root: install pinned updater dependency, add separate bucket binding, per-user NSIS config, version1.1.1 and documented next-version naming. Generate Worker types.
- [x] Root: publisher script reads local private token, verifies local metadata checksums, streams installer in bounded multipart chunks, validates public download bytes, then publishes latest.yml last.
- [x] Review integration and run complete tests/typechecks/builds; fix blockers.
- [x] Deploy Worker preserving existing secrets/bindings/schedules; configure separate bucket and publication secret; upload release artifacts and manifest last.
- [x] Verify real production download and checksum with packaged updater. Exercise installation/update using isolated acceptance application identity/profile/channel so production account/task data are untouched. Report any unavailable end-to-end validation accurately.
- [x] Verify package metadata, native files, icon, source exclusion and final feed; sync private GitHub and deliver the installer with one-time migration instructions.

User approved installer migration and automatic background downloads, explicit restart while idle. Do not enable forced restarts, downgrade, production credential resets, or image deletions as part of this feature.

Verification: 249 tests across 27 files, both TypeScript checks and production build passed. Production NSIS package/feed SHA512 and full remote bytes verified. A separate installed acceptance application upgraded 1.1.0 to 1.1.1 through the actual Electron updater and NSIS installer, preserving fixture settings and progress; it was uninstalled afterward. Production profile was not used.
