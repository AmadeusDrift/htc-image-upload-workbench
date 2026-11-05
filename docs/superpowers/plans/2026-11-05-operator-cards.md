# Operator cards 1.1.3 implementation plan

> Execute the independent backend and native tasks with subagent-driven-development, followed by independent review. User confirmed anyone with the installer can select a profile directly; do not add activation or passwords to the operator path.

**Goal:** Make the default entry screen show alpha/beta/gamma/delta occupancy and enter directly, preserve administrator password login, and preserve unfinished queues when selecting another profile.

**Architecture:** Add opt-in public operator entry, restricted to the four active employee accounts with existing permissions. Keep password login and existing upload APIs. Authenticated presence heartbeats provide recent-online counts; leases provide uploading counts. Archive local manifests per owner before switching, preserving the existing primary manifest and schema.

**Stack:** Existing React, Electron, Workers/D1, Vitest/Miniflare.

## Backend task

- Add `server/operator-entry.ts` and integration tests `server/tests/operator-entry.test.ts`; edit only relevant routes in `server/index.ts` and `.dev.vars.example`.
- Add opt-in `OPERATOR_CARD_ENTRY_ENABLED` flag. Health exposes `operatorEntryEnabled`.
- `GET /api/operator-status` returns `{profiles:[{id,username,displayName,available,onlineDevices,uploadingDevices,uploadSlots}],globalSlots,globalLimit:20}` with the four names in stable order. Never include passwords, tokens, hashes, group permissions or administrators.
- `POST /api/operator-entry` with username and deviceId issues the existing device-bound session only for an enabled allowlisted employee. Validate body/header device identity and throttle repeated entry.
- `GET /api/presence` authenticates cheaply; `POST /api/presence/leave` marks only the current session inactive. Existing passwords, sessions, roles and task ownership remain intact.
- RED then GREEN: four names in order, no password, deny administrator/disabled/unlisted profiles, no secret fields, accurate distinct devices/leases, default disabled, old password login compatibility.

## Native queue task

- Add `electron/profile-manifest.cjs`, tests, and optional `desktop.loadUserManifest(ownerId)` IPC in main/preload/types.
- Before owner switch, archive the valid primary checkpoint under an owner-hashed path; then restore that owner's primary or archived checkpoint. Keep original paths/schema and trusted-source validation.
- Update `UploadEngine.bindUser` to use the optional API; preserve compatibility when absent. Add a regression that alpha -> beta -> alpha restores the exact unfinished alpha task, source handles, successful rows and pending tail without a new task.
- RED then GREEN: owner switching, same owner, empty owner, corrupted file/backup recovery, disk failure prevents destructive overwrite, arbitrary owner strings cannot escape the profile directory.

## Entry UI task

- Add `src/OperatorEntry.tsx`, CSS and tests. Preserve existing blue/white brand and left panel. Right panel has four account buttons, online/upload/slot counts, loading/error/retry states, and a quiet administrator password entry link.
- Refresh status every 10 seconds with abort/stale/unmount guards. Prevent double entry while pending. Keep occupied profiles selectable because devices share dynamic capacity.
- In App use cards when initialized and `health.operatorEntryEnabled`; otherwise keep existing setup/password compatibility. On successful entry restore owner checkpoint before exposing workspace. Add cheap presence heartbeats while signed in.
- Verify default UI contains no password input, four cards, status refresh, failed entry stays visible, administrator path, session-switch race protection and queue restoration.

## Integration and release

- Bump to 1.1.3; run `npm run typecheck`, Worker typecheck, `npm run build:web`, `npm run build:server`, `npm test` and NSIS packaging with `--publish never`.
- Inspect desktop at 1440x940 and 1080x720; test keyboard/card accessibility. Independently review auth and queue changes before publishing.
- Before deployment recheck active uploads, preserve secrets/bindings and set only the entry opt-in flag. Verify live anonymous operator entry has employee permissions, administrator still requires password, original task links work, and quota remains 20.
- Publish immutable 1.1.3 installer/blockmap; verify bytes before publishing latest.yml last. Confirm 1.1.2 detects 1.1.3 and report precise employee update steps. Never replace released 1.1.2 bytes.
