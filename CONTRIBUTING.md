# Contributing to CludeGods

Thanks for helping. CludeGods is alpha, so small, focused changes are easiest to review.

## How a change lands

1. **Branch from `main`**, named for what it does: `feat/hourly-wakes`, `fix/echo-at-start`,
   `docs/install-guide`, `chore/ci`.
2. **Make the change and test it** (below). Keep each pull request to one topic.
3. **Add a line to [CHANGELOG.md](CHANGELOG.md)** under `## [Unreleased]`, in the right
   group (Added, Changed, Fixed, Removed, Security), written for someone using CludeGods.
4. **Open a pull request.** The template asks what changed, how you verified it, and how the
   safety model holds. CI runs on every pull request; it must be green.
5. **Squash-merge** once it is reviewed and green, with a message in the imperative
   ("Add hourly wake schedules").

## Testing

What CI runs, and you can run locally from the repo root:

```bash
python3 -I skills/colleague/bin/listen.py --selftest
python3 -I skills/colleague/bin/guard --selftest
python3 -B -I -m unittest discover -s skills/spaces/tests
python3 -B -I -m unittest discover -s skills/colleague/bridges/slack/tests
scripts/build-pill.sh && skills/colleague/bin/pill --snapshot /tmp/callpill.png
```

What CI cannot run, so run it yourself before opening the pull request:

- **Mods**: `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`
  (Claude Code's own runner), and `tsc -p mods/<name>` after loading the mod once.
- **The echo gate on a real call**: `listen.py --replay <heard log> --speakers`, before and
  after your change, on a log of your own.
- **Anything you can see**: a screenshot of the pane or the pill in the pull request.

## Releasing

When a set of changes is ready to ship:

1. Move the `## [Unreleased]` entries under a new `## [x.y.z] - YYYY-MM-DD` heading, and
   update the compare links at the bottom.
2. Bump `version` in each `mods/*/.claude-plugin/plugin.json` that changed.
3. Merge that, then tag `main`: `git tag -a vx.y.z -m "CludeGods x.y.z"` and push the tag.
4. Publish a GitHub release for the tag with that version's changelog section as its notes.

While the version is 0.x, a minor release adds features and a patch release fixes things.

## Ground rules

- **Keep the [safety model](README.md#safety-model) intact.** Anything that approves,
  sends, or starts sessions needs to say in its pull request how the change preserves it:
  only a click or a typed yes approves, voice never starts sessions, names are never
  fuzzy-matched.
- **No secrets and no personal data** in commits: no tokens, no real names, emails or
  session ids, no absolute home paths (use `~` or `$HOME`).
- **Credit what you build on** in [NOTICE](NOTICE) and the README's Credits.
