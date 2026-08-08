# Decision: no OS code signing certificate purchase

- **Decided:** 2026-07-19
- **Re-affirmed:** 2026-08-08 (backlog burn-down; moved here out of `TODO.md`, where it was reading as outstanding work rather than as a settled decision)
- **Status:** standing decision — revisit only on the triggers below
- **Full technical spec:** `docs/superpowers/plans/2026-07-19-signing-updater-release.md`

## Decision

Minder's installers ship **unsigned** at the OS level. No certificate is purchased.

## Context

This is easy to confuse with the auto-updater's signing, which is a **separate mechanism and already works**. The updater uses minisign, which is free, and v1.6.0 was the first release to successfully self-apply an update. Update verification is not affected by this decision.

What is deferred is **OS code signing** — the thing SmartScreen (Windows) and Gatekeeper (macOS) check on first download.

## Why not

**It is money-gated and platform-split.** No single certificate can sign both platforms; that is structurally impossible, not a procurement problem.

| Platform | What is needed | Cost |
|---|---|---|
| macOS | Apple Developer ID — **already held**. Needs only `APPLE_*` secrets wiring; Tauri automates notarization. | already paid |
| Windows | Azure Trusted Signing (cloud HSM) | ~$120/yr |

Traditional Windows OV certificates stopped being an option for CI in June 2023, when the CA/Browser Forum began requiring private keys on certified hardware. A USB token cannot be used from a hosted runner, so the cloud-HSM route is the only CI-compatible one.

## Consequence, accepted

First-time downloaders see a SmartScreen or Gatekeeper warning and must click through. For a local-only personal dashboard with a small install base, this is tolerable.

## Triggers to revisit

1. **Distribution beyond personal/small-circle use** — the warning becomes a real adoption barrier the moment strangers are the audience.
2. **Wanting the macOS half only** — this is nearly free, since the Developer ID is already held. Wiring `APPLE_*` secrets into the release workflow is a contained task and does not require the Windows spend.
3. **Windows signing costs falling**, or a CI-compatible option appearing below the current price.
