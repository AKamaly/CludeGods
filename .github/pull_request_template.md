## What this changes

<!-- One or two sentences, for someone using CludeGods. -->

## How it was verified

<!-- Commands and results; a screenshot for anything you can see (a pane, the pill). -->

- [ ] CI is green
- [ ] Mods touched: `claude plugin test mods/<name>` passes locally
- [ ] Echo gate touched: `listen.py --replay` before and after on a real log

## Checklist

- [ ] A line under `## [Unreleased]` in CHANGELOG.md
- [ ] The safety model holds (only a click or a typed yes approves; voice never starts sessions)
- [ ] No secrets, personal data, session ids or absolute home paths
