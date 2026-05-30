# Referenced Repositories

Other projects we've referenced as inspiration for Project Minder features, across the
README, `TODO.md` roadmap, `CHANGELOG.md`, and the marketing site. Each entry notes what
it inspired and where the reference lives in our repo.

> Excluded: `foo/bar`, `clerk/skills`, `vercel/skills`, `scikit-learn`, and
> `anthropics/claude-code` appearing in `tests/` and `src/lib/` — those are test fixtures
> or the product we parse, not feature inspirations.

## Shipped feature inspirations (README "Inspired By")

| Repo | Inspired | Referenced in |
|------|----------|---------------|
| [AgentSeal/codeburn](https://github.com/AgentSeal/codeburn) | Token cost analytics design (Usage dashboard) | README, CHANGELOG, `site/index.html` |
| [chiphuyen/sniffly](https://github.com/chiphuyen/sniffly) | Stats dashboard concept | README, CHANGELOG, `site/index.html` |
| [JayantDevkar/claude-code-karma](https://github.com/JayantDevkar/claude-code-karma) | Sessions browser concept | README, CHANGELOG, `site/index.html`, `TODO.md` |
| [minchenlee/c9watch](https://github.com/minchenlee/c9watch) | Live session status monitoring concept | README, `site/index.html` |
| [raphi011's insights gist](https://gist.github.com/raphi011/dc96edf80b0db8584527fefc6a3b4bd0) | Insights extraction concept | README, `site/index.html` |

## Roadmap / TODO inspirations

| Repo | Inspired (TODO.md section) | Status |
|------|---------------------------|--------|
| [mcpware/cross-code-organizer](https://github.com/mcpware/cross-code-organizer) | MCP & Config Security — live MCP server connection + multi-layer threat analysis (rug-pull detection) | Backlog |
| [huylq98/clauditor](https://github.com/huylq98/clauditor) | Live Activity & Hook Instrumentation — real-time state via Claude Code lifecycle hooks | Backlog |
| [softcane/clauditor](https://github.com/softcane/clauditor) | Session Quality & Cost Efficiency — diagnostic taxonomy + cost formulas (Envoy proxy for budgets/degradation) | Backlog (proxy parts N/A) |
| [IyadhKhalfallah/clauditor](https://github.com/IyadhKhalfallah/clauditor) | Session Intelligence & Project Knowledge — cross-session learning / per-project knowledge base from JSONL | Partially shipped (Wave 2.2) |
| [pdugan20/claudelint](https://github.com/pdugan20/claudelint) ([rules](https://claudelint.com/rules/overview)) | ClaudeLint integration — workspace-wide config linting (CLAUDE.md, skills, settings) | **Shipped** (Waves A–F, `configLint` flag) |
| [Arindam200/cc-lens](https://github.com/Arindam200/cc-lens) | Session Replay & Engagement Analytics — under-explored JSONL fields + `~/.claude/usage-data/facets/` satisfaction files | Backlog |
| [hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) | Advanced Session Visualizations — D3 workflow viz from `parentToolUseID` relationships | Backlog (needs `d3`/`d3-sankey`) |
| [getagentseal/codeburn](https://github.com/getagentseal/codeburn) | Multi-Platform & Codex Support — 16-provider coverage model | Partially shipped (adapter registry, Wave 10.2a) |
| [f/agentlytics](https://github.com/f/agentlytics) | Multi-Platform & Codex Support + Additional Backlog — 17-editor coverage model | Backlog |

> Note: `getagentseal/codeburn` and `AgentSeal/codeburn` are the same project under an
> org rename. The three `clauditor` forks (huylq98, softcane, IyadhKhalfallah) are distinct
> projects with different architectures, each inspiring a different feature area.
