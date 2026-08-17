# Demo-mode coverage audit

Two throwaway-shaped passes, kept in the repo because `TODO.md` asks a future
session to finish triaging the route tail and the findings doc
(`docs/demo-mode-coverage.md`) cites them as its method.

```bash
node scripts/audit-demo-coverage/pass1-guard-reachability.mjs   # writes demo-audit.json
node scripts/audit-demo-coverage/pass2-data-sources.mjs         # reads it, writes demo-leaks.json
```

**Pass 1** walks the local import graph from every `src/app/api/**/route.ts` and
reports which routes can reach a `demoMode()` read-guard, a `demoWriteBlock()`
write-guard, or neither.

**Pass 2** takes the unguarded set and asks which of them reach a real-data
source (`~/.claude`, the index DB, the project scan, the tasks DB, the usage
parser).

## Read the output as a search aid, never as a verdict

Both directions of error are common, and one of them is dangerous:

- **False positives** — reaching a real-data source is not reading it.
  `notifications/push/vapid-public-key` looks like it touches `~/.claude`
  because something it imports does.
- **False negatives** — reaching a `demoMode()` *call* is not being guarded by
  it. `/api/claude-config` was reported **covered** while its user-scope half
  was completely unguarded. So the "guarded" count is unreliable in the
  optimistic direction, and a route these scripts clear still has to be read.

Every finding in `docs/demo-mode-coverage.md` was confirmed by reading the code
path, and the fixed ones additionally by a mutation-tested guard.

The `*.json` outputs are intermediates; regenerate rather than commit them.
