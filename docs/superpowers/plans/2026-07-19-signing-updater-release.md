# Signing, Auto-Updater, and Local Release — plan

**Created:** 2026-07-19
**Supersedes:** task **C5** of `2026-07-16-service-and-tray.md` (deferred 2026-07-18)
**Status table is the source of truth** (bottom of this doc).

---

## Why this supersedes C5

C5 bundled "signing + updater" into one deferred task, and the deferral rationale was
entirely about **money** — $99/yr Apple, plus a Windows cert. That framing conflated two
things that are technically independent:

| | Purpose | Cost | Blocks what |
|---|---|---|---|
| **OS code signing** (Authenticode / Apple Developer ID) | Stops SmartScreen + Gatekeeper warnings on **install** | ~$219/yr | First-run friction |
| **Updater signing** (minisign) | Authenticates **update payloads** so the app won't install a tampered binary | **Free** | Nothing |

Minisign signing does nothing for SmartScreen; code signing does nothing for the updater.
**An updater-only slice ships today at zero cost.** Users would still see SmartScreen on
the initial download, but every subsequent update would be automatic and verified.

That is the main reason to reopen C5 now rather than continue waiting for "real users."

## The other reason: two 2024–2026 changes invalidate the old cost model

1. **EV certificates no longer grant instant SmartScreen reputation** (removed 2024).
   Microsoft's [code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
   table marks EV as "Same as OV since 2024 — no longer instant bypass." **Tauri's own
   Windows signing docs are stale and still claim otherwise.** Do not budget for EV.
2. **Azure Artifact Signing** (renamed from Trusted Signing, Jan 2026) is ~$9.99/mo with
   cloud HSM keys and no hardware dongle. Individual validation appears to be ID-only now
   (government photo ID + proof of address); the old 3-year-business-history rule was a
   public-preview restriction.

Meanwhile traditional OV certs became **CI-incompatible**: since June 2023 CA/B Forum
requires the private key on non-exportable FIPS hardware, so you cannot sign from GitHub
Actions with a token-based OV cert at all.

---

## Decisions

- **Windows:** Azure Artifact Signing (~$120/yr). Not EV — it buys nothing on SmartScreen now
  and costs 4×. Not OV-on-token — cannot work in CI.
- **macOS:** existing Apple Developer Program membership ($99/yr, already held). Tauri
  automates notarization (submit → poll → staple) once env vars are set.
- **No single cert signs both** — structurally impossible. Windows Authenticode chains to the
  Microsoft Trusted Root Program; Apple is its own exclusive CA for Developer ID. Two
  identities, one pipeline.
- **Updater ships independently of and before signing**, since it is free and unblocked.
- **Updater hosting:** GitHub Releases + a generated `latest.json`, endpoint
  `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.
- **Reputation is not purchasable.** It accrues per-file-hash through download volume, and
  the old "submit to Microsoft for review" path no longer exists. Early users will see
  warnings regardless of spend. Plan a soft launch rather than a big-bang release.

---

## Sequencing

Account validation is the **critical path** — Azure individual validation takes 1–20 business
days. Start S1/S2 immediately, then build R and U while waiting.

```
S1 Azure signup ─────────────(1–20 business days)────────────┐
S2 Apple cert + API key ─────(hours)─────────┐               │
                                             │               │
R1 release-local script ──► R2 docs          │               │
       │                                     │               │
       └──► U1 keypair ──► U2 config ──► U3 Rust ──► U5 CI ──┴──► S3 CI signing ──► S4 verify
                                              │
                                              └──► U4 exit-guard fix (blocks U3 on Windows)
```

---

## R — Local release script

**Why:** the full chain exists only as steps in `release-installers.yml`. Reproducing a
release locally means running five commands by hand in the right order, and getting it wrong
produces a subtly broken payload (e.g. skipping the hygiene gate).

**R1 — `scripts/release-local.mjs` + `pnpm release:local`**

Chains: `pnpm build` (which runs `prebuild`→`build:worker`) → `pnpm package:standalone` →
`node scripts/verify-payload-hygiene.mjs` → `node scripts/fetch-node-runtime.mjs` →
`pnpm tauri build`.

Requirements:
- `--bundles <list>` passthrough; default to the host OS's natural target.
- `--skip-build` / `--skip-node` for iteration (the Node fetch is ~80 MB).
- **Version consistency check up front.** `tauri.conf.json` is authored as `0.1.0` and the
  workflow stamps it from `package.json` at build time (`release-installers.yml:175`). A local
  build that skips the stamp produces an installer versioned `0.1.0` — which, once the updater
  lands, means **every install would think it's ancient and update-loop**. The script must
  perform the same stamp, and fail loudly if `package.json` and the tag disagree.
- Fail fast with the same semantics as CI (`if-no-files-found: error` equivalent).
- Print the resulting artifact paths + sizes at the end.

**R2 — Document it** in `docs/help/` and the plan status table. Note the Windows caveat that
`TAURI_SIGNING_PRIVATE_KEY` must be a real env var (`$env:` in PowerShell) — `.env` files are
explicitly not read by Tauri.

---

## U — Auto-updater

**Feasibility confirmed:** `tauri-plugin-updater` has a **full Rust API**
(`app.updater_builder()` → `check()` → `download_and_install()`), so the windowless tray is
*not* a blocker. The plugin's JS API is webview-side, but nothing requires it.

**U1 — Generate and safeguard the minisign keypair** *(MANUAL — see MANUAL_STEPS.md)*

`pnpm tauri signer generate -w ~/.tauri/minder.key`. Public key **content** (not a path) goes
in `tauri.conf.json`; private key goes in the `TAURI_SIGNING_PRIVATE_KEY` GitHub secret.

> **This key is unrecoverable and permanent.** If it is lost, every already-installed user is
> stranded forever — you can never ship them another update, because their installed binary
> only trusts that public key. Back it up somewhere durable *before* the first signed release.

**U2 — Config + toolchain**

- `bundle.createUpdaterArtifacts: true`
- `plugins.updater.pubkey` + `plugins.updater.endpoints`
- `installMode: "passive"` (small progress window, no interaction — the right default for a
  tray app; `"quiet"` cannot self-elevate and `"basicUi"` requires interaction)
- Bump `Cargo.toml` `rust-version` from `1.77` to `1.77.2` (plugin minimum).

**U3 — Rust wiring**

- Add `tauri-plugin-updater`, register alongside the existing plugins (`main.rs:27-46`).
- Periodic check off the existing 15s health loop (`tray.rs:237-255`) via a counter — do
  **not** add a second timer.
- New `Check for updates…` menu item near `tray.rs:71` + match arm near `:150`, backgrounded
  with `thread::spawn` following the existing `restart` precedent at `:148`.
- **`on_before_exit(|| supervisor.shutdown())`** — this is close to a one-liner, because
  `supervisor.rs:139` already implements the hardened graceful stop (stdin `shutdown\n`, 12s
  bounded wait, then `taskkill /F /T` on the tree). Windows forcibly quits the app before the
  NSIS installer runs, and if the `node.exe` child is still alive it will **lock
  `resources/node/node.exe` and fail the install**. This hook is the only window to stop it.

**U4 — Resolve the exit-guard conflict** *(blocks U3 on Windows)*

`main.rs:76-88` calls `api.prevent_exit()` when `code.is_none()`, to keep the windowless app
alive. The updater's forced Windows quit must **not** be swallowed by that guard. Verify what
`RunEvent::ExitRequested` carries on an updater-initiated exit and add an explicit
"updating" flag the guard checks. **Smoke-test this early** — if the guard eats the exit, the
update silently fails to install and the app appears to hang.

**U5 — CI**

- **macOS arm64 currently builds `dmg` only** (`release-installers.yml:88`), but the updater
  needs `.app.tar.gz`. Change to `dmg,app`. (The Intel job already builds `app`.)
- Generate `latest.json` in the "Collect installers" step (`:228`) by reading each `.sig`
  file's **literal content** — a path or URL in that field does not work. Tauri validates the
  entire manifest before checking the version, so a malformed entry for a platform you don't
  even ship will break update checks for everyone.
- Add `TAURI_SIGNING_PRIVATE_KEY` (+ password) secrets to the build step (`:211`).

**U6 — Document the `.deb` limitation**

`.deb` and `.rpm` **structurally cannot self-update** — the runtime error is literally
"Currently only an AppImage can be updated." This is by design. AppImage users in the same CI
job update fine. Document that `.deb` users update via manual download.

---

## S — Code signing

**S1 — Azure Artifact Signing account + individual validation** *(MANUAL, long lead)*
**S2 — Apple Developer ID Application cert + App Store Connect API key** *(MANUAL)*

Both in MANUAL_STEPS.md. S1 is the critical path.

**S3 — CI wiring**

- **Windows:** install `artifact-signing-cli`, point `bundle.windows.signCommand` at it.
  Do **not** use `certificateThumbprint` — Tauri marks that path as applying only to OV certs
  acquired before June 2023. Prefer **OIDC** (`azure/login@v3` + `azure/artifact-signing-action@v2`,
  `permissions: id-token: write`) over a long-lived client secret; requires the
  `Trusted Signing Certificate Profile Signer` role.
- **macOS:** `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  plus `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH` for notarization. Tauri
  runs the notarytool flow itself.
- Update the "Signing: UNSIGNED for now" comment at `release-installers.yml:29-31`.

**S4 — Verify on clean machines.** Download each installer on a machine that has never seen
the app and confirm the actual warning behavior. Signed-but-no-reputation still shows
SmartScreen; that is expected, not a failure.

---

## Risks and open questions

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Minisign key loss strands all users permanently** | Back up before first signed release (U1). Highest-severity item here. |
| 2 | `prevent_exit` guard swallows the updater's forced quit | U4, smoke-test early |
| 3 | `capabilities/` may be required — the dir does not exist at all today | Docs suggest `updater:default` for the *IPC* layer; the Rust API shouldn't cross it. Verify in U3; if needed it's a new file, not an edit |
| 4 | Every update is a **full ~100 MB download** (bundled Node + Next payload) | Accepted. No differential updates in Tauri. Consider update cadence accordingly |
| 5 | `tauri.conf.json` version is `0.1.0`, stamped at build | R1 must stamp identically or local builds update-loop |
| 6 | Updater while the tray is in **attach mode** won't free the port (`supervisor.rs:23` deliberately never kills an incumbent) | Detect attach mode and refuse/warn rather than half-updating |
| 7 | Azure's individual-eligibility change date is **unconfirmed** (source returned HTTP 429) | Verify at signup before planning around it |
| 8 | Microsoft silently migrated Artifact Signing to new intermediate CAs in Mar 2026, **resetting reputation** ([issue #128](https://github.com/Azure/artifact-signing-action/issues/128)) | Don't rotate certs near a release |
| 9 | Cert validity capped at **458 days** (CA/B Forum, Mar 2026) | Calendar the renewal |
| 10 | First async code in the crate (`async_runtime::spawn`); everything else is `std::thread` + blocking `ureq` | Keep the async surface to the updater call itself |

---

## Status

| Task | Description | Status |
|---|---|---|
| R1 | `scripts/release-local.mjs` + `pnpm release:local` | DONE (b8ba9e6) |
| R2 | Document local release flow | DONE — `docs/help/tray-app.md` |
| U1 | Generate + back up minisign keypair | PARTIAL — key generated; **backup + GitHub secret still MANUAL** |
| U2 | Updater config + `rust-version` bump | DONE |
| U3 | Rust wiring (plugin, menu item, `on_before_exit`) | DONE (3d31ad5) |
| U4 | Resolve `prevent_exit` vs forced-quit conflict | DONE — **non-issue**, see below |
| U5 | CI: arm64 `app` target, `latest.json`, signing secret | DONE — untested until a real tag |
| U6 | Document `.deb` no-self-update limitation | DONE |
| S1 | Azure Artifact Signing signup + validation | **DROPPED for now** — decision 2026-07-19: no cert spend |
| S2 | Apple Developer ID cert + API key | DEFERRED — account already held, wire up later |
| S3 | CI signing wiring (Windows `signCommand`, macOS notarization) | blocked on S1/S2 |
| S4 | Verify on clean machines | blocked on S3 |

### U4 resolved — the guard was never the problem

The plan predicted `main.rs`'s `prevent_exit` guard might swallow the updater's forced
Windows quit. It cannot: `download_and_install` exits via `std::process::exit()`, which
never reaches Tauri's event loop, so there is no `ExitRequested` for the guard to see.

The real hazard is the *other* consequence of that same hard exit — **no destructors run**.
The Node sidecar is a child process, not a resource freed by unwinding, so without explicit
action it survives as an orphan, keeps `resources/node/node.exe` locked, and the NSIS
installer fails on a locked file. `supervisor.shutdown()` therefore runs from the plugin's
`on_before_exit` hook, the only code that executes in that window.

### What is NOT yet verified

The CI path has never run. `latest.json` generation, the arm64 `app` target, and the Windows
install hand-off are correct by construction and unit-tested, but no tagged release has
exercised them end to end. The first `v*` tag after this lands is the real test — and it will
**fail loudly** at the "Emit updater artifact" step until the `TAURI_SIGNING_PRIVATE_KEY`
secret exists, because without a signing key Tauri emits no `.sig` and that step refuses to
guess.

The first release carrying the updater also cannot be *received* as an update by anyone: the
currently-installed 1.4.0 builds have no updater in them. Everyone must download the next
release manually once; self-updating begins from the release after that.
