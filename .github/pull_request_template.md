## What this changes

<!-- One or two sentences, for someone using CludeGods. -->

## How it was verified

<!-- Commands and results; a screenshot for anything you can see (a pane, the pill). -->

- [ ] CI is green
- [ ] Mods touched: `claude plugin test mods/<name>` passes locally
- [ ] Echo gate touched: `listen.py --replay` before and after on a real log

## Checklist

- [ ] A line under `## [Unreleased]` in CHANGELOG.md
- [ ] The safety model holds (nothing outward on an unconfirmed line: a read-back and a clear yes, or a typed yes in strict mode; voice never answers a permission prompt; voice never starts sessions; names are never fuzzy-matched)
- [ ] No secrets, personal data, session ids or absolute home paths
