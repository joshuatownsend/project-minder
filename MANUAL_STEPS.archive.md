# Manual Steps — Archive

<!-- Fully-completed MANUAL_STEPS entries, archived from MANUAL_STEPS.md. Seeded 2026-06-26. -->

## 2026-03-17 14:32 | notifications | Toast & OS Notification Setup

- [x] Grant browser notification permission when prompted
  Click "Allow" on the browser permission dialog
- [x] Verify notification sound plays on new entry detection
  Open DevTools console and check for audio errors
- [x] Add notification.wav to public/sounds/
  Already done during implementation

---

## 2026-03-17 15:10 | testing | Manual Steps Feature Verification

- [x] Visit /manual-steps page and verify cross-project view
  See: http://localhost:4100/manual-steps
- [x] Click a project card with manual steps, check the new tab
- [x] Toggle a checkbox and verify MANUAL_STEPS.md updates on disk
- [x] Test real-time detection by appending a new entry to any MANUAL_STEPS.md

---

## 2026-04-16 | github-pages | Enable GitHub Pages from gh-pages branch

- [x] Go to https://github.com/joshuatownsend/project-minder/settings/pages
- [x] Under "Build and deployment" → Source, select "Deploy from a branch"
- [x] Branch: gh-pages, Folder: / (root)
- [x] Click Save
  Site will be live at https://joshuatownsend.github.io/project-minder within ~1 minute

---
