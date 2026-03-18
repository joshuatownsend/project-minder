# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Hide projects UI** — Three-dot menu on project cards with "Hide project" action. Confirmation dialog before hiding. "(N hidden)" link in dashboard footer opens a manage modal to view and unhide projects. Uses `@radix-ui/react-dropdown-menu`.
- **Manual Steps Tracker** — Surfaces `MANUAL_STEPS.md` entries across all projects. Interactive checkboxes toggle steps on disk. Cross-project dashboard at `/manual-steps`. File watcher with real-time toast + OS notifications when Claude adds new steps.
- **Help system** — Contextual help panel (`?` shortcut) with docs for each page/tab. Help mapping for all routes.
- **Toast notification system** — Reusable toast provider with auto-dismiss, used by manual steps notifications.

### Changed
- Scanner now runs 8 modules (added `manualStepsMd`).
- Layout header includes "Manual Steps" nav link with pending count badge.
- Project detail page has a "Manual Steps" tab when applicable.
- Project cards show pending manual step count in amber.
