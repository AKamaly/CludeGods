"""Unit tests for the `pages` CLI (skills/colleague/bin/pages).

Each test runs the real script in a subprocess against a fresh temporary HOME, so nothing
touches the owner's own ~/.voicemode. Run:

    python3 -m unittest discover -s ~/.claude/skills/spaces/tests -v
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

PAGES = Path(os.environ.get("PAGES_BIN") or Path(__file__).resolve().parents[2] / "colleague" / "bin" / "pages")

REGISTRY = {
    "workers": [
        {"key": "scribe", "name": "Scribe", "session": "local_scribe", "spaces": ["notes"], "extra": {"kept": True}},
        {"key": "scout", "name": "Scout", "session": "local_scout"},
        {"key": "keeper", "name": "Keeper", "spaces": "*"},
    ]
}


class PagesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="pages-test-"))
        self.call = self.home / ".voicemode" / "call"
        self.call.mkdir(parents=True)
        (self.call / "workers.json").write_text(json.dumps(REGISTRY), encoding="utf-8")
        self.spaces = self.call / "spaces"

    def tearDown(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)

    # ------------------------------------------------------------ helpers

    def run_pages(self, *args: str, stdin: str | None = None, code: int = 0) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "en_US.UTF-8"}
        proc = subprocess.run([sys.executable, str(PAGES), *args], input=stdin, capture_output=True,
                              text=True, env=env, timeout=30)
        self.assertEqual(proc.returncode, code, f"pages {' '.join(args)}\nstdout: {proc.stdout}\nstderr: {proc.stderr}")
        return proc

    def json_of(self, *args: str, stdin: str | None = None):
        return json.loads(self.run_pages(*args, "--json", stdin=stdin).stdout)

    def front(self, path: Path) -> tuple[dict, str]:
        text = path.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"), text)
        head, _, body = text[4:].partition("\n---\n")
        meta = {}
        for line in head.splitlines():
            k, _, v = line.partition(": ")
            meta[k] = json.loads(v) if v.startswith('"') else v
        return meta, body.lstrip("\n")

    def outbox(self, key: str) -> list[dict]:
        path = self.call / "outbox" / f"{key}.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    # ------------------------------------------------------------ spaces

    def test_first_run_seeds_memory_and_notes_with_welcome_pages(self):
        spaces = self.json_of("spaces")
        self.assertEqual([s["slug"] for s in spaces], ["memory", "notes"])
        self.assertEqual([s["pages"] for s in spaces], [1, 1])
        meta, body = self.front(self.spaces / "memory" / "welcome.md")
        self.assertEqual(meta["title"], "About Memory")
        self.assertEqual(meta["by"], "you")
        self.assertIn("every worker may read", body)
        info = json.loads((self.spaces / "notes" / "space.json").read_text())
        self.assertEqual(info["name"], "Notes")
        self.assertIn("created", info)

    def test_memory_comes_back_but_a_deleted_notes_space_does_not(self):
        self.run_pages("spaces")
        shutil.rmtree(self.spaces / "memory")
        shutil.rmtree(self.spaces / "notes")
        spaces = self.json_of("spaces")
        self.assertEqual([s["slug"] for s in spaces], ["memory"])

    def test_mkspace_makes_a_slug_and_refuses_a_duplicate(self):
        out = self.run_pages("mkspace", "Launch Plans", "--emoji", "🚀").stdout.strip()
        self.assertEqual(out, "launch-plans")
        info = json.loads((self.spaces / "launch-plans" / "space.json").read_text())
        self.assertEqual(info["name"], "Launch Plans")
        self.assertEqual(info["emoji"], "🚀")
        err = self.run_pages("mkspace", "launch plans", code=1).stderr
        self.assertIn("exists already", err)
        self.run_pages("mkspace", "   ", code=2)
        self.run_pages("mkspace", "!!!", code=2)

    def test_unicode_names_make_unicode_slugs(self):
        self.assertEqual(self.run_pages("mkspace", "ملاحظات").stdout.strip(), "ملاحظات")
        slug = self.run_pages("new", "ملاحظات", "خطة الإطلاق").stdout.strip()
        self.assertEqual(slug, "ملاحظات/خطة-الإطلاق")

    # ------------------------------------------------------------ new, list, show

    def test_new_list_and_show_with_subpages(self):
        self.run_pages("spaces")
        self.assertEqual(self.run_pages("new", "notes", "Launch brief: v2").stdout.strip(), "notes/launch-brief-v2")
        self.run_pages("new", "notes", "Risks", "--parent", "launch-brief-v2", "--from", "-", stdin="# Risks\n\nShipping late.\n")
        self.run_pages("new", "notes", "Deep risk", "--parent", "risks")
        rows = self.json_of("list", "--space", "notes")
        self.assertEqual([(r["slug"], r["depth"]) for r in rows],
                         [("launch-brief-v2", 0), ("risks", 1), ("deep-risk", 2), ("welcome", 0)])
        text = self.run_pages("list", "--space", "notes").stdout
        self.assertIn("  notes/risks\tRisks", text)
        shown = self.run_pages("show", "notes/risks").stdout
        self.assertTrue(shown.startswith("---\ntitle: Risks\n"))
        self.assertIn("parent: launch-brief-v2", shown)
        self.assertTrue(shown.endswith("Shipping late.\n"))
        meta, _ = self.front(self.spaces / "notes" / "launch-brief-v2.md")
        self.assertEqual(meta["title"], "Launch brief: v2")  # quoted on disk, read back whole
        page = self.json_of("show", "notes/risks")
        self.assertEqual(page["body"], "# Risks\n\nShipping late.\n")
        self.assertEqual(page["parent"], "launch-brief-v2")

    def test_new_takes_a_unique_slug_and_needs_a_real_parent_and_space(self):
        self.run_pages("spaces")
        self.run_pages("new", "notes", "Plan")
        self.assertEqual(self.run_pages("new", "notes", "Plan").stdout.strip(), "notes/plan-2")
        self.assertIn("No page notes/nope", self.run_pages("new", "notes", "X", "--parent", "nope", code=1).stderr)
        self.assertIn("No space 'ghost'", self.run_pages("new", "ghost", "X", code=1).stderr)
        self.run_pages("new", "notes", "  ", code=2)

    def test_new_by_a_worker_records_it_and_respects_its_spaces(self):
        self.run_pages("spaces")
        page = self.json_of("new", "notes", "Asked for", "--worker", "scribe")
        self.assertEqual(page["by"], "scribe")
        self.assertIn("may not write to 'memory'", self.run_pages(
            "new", "memory", "Tone", "--worker", "scribe", code=4).stderr)

    def test_search_matches_title_and_text_newest_first(self):
        self.run_pages("spaces")
        self.run_pages("new", "notes", "Alpha", "--from", "-", stdin="the quick brown fox\n")
        time.sleep(0.01)
        self.run_pages("new", "notes", "Fox facts")
        rows = self.json_of("list", "--q", "FOX")
        self.assertEqual([r["slug"] for r in rows], ["fox-facts", "alpha"])
        self.assertEqual(self.run_pages("list", "--q", "zebra").stdout.strip(), "No matching pages")

    def test_a_parent_loop_and_a_missing_parent_still_list_every_page(self):
        self.run_pages("spaces")
        notes = self.spaces / "notes"
        (notes / "a.md").write_text("---\ntitle: A\nparent: b\n---\n", encoding="utf-8")
        (notes / "b.md").write_text("---\ntitle: B\nparent: a\n---\n", encoding="utf-8")
        (notes / "c.md").write_text("---\ntitle: C\nparent: gone\n---\n", encoding="utf-8")
        (notes / "plain.md").write_text("No front matter here.\n", encoding="utf-8")
        rows = self.json_of("list", "--space", "notes")
        self.assertEqual(sorted(r["slug"] for r in rows), ["a", "b", "c", "plain", "welcome"])
        self.assertEqual(next(r for r in rows if r["slug"] == "c")["depth"], 0)
        self.assertEqual(next(r for r in rows if r["slug"] == "plain")["title"], "plain")

    # ------------------------------------------------------------ safety

    def test_slugs_cannot_climb_out_of_the_spaces_folder(self):
        self.run_pages("spaces")
        for target in ["../etc", "notes/../../x", "notes/.hidden", "notes/a.b", "/abs/x", "notes/"]:
            self.run_pages("show", target, code=1)
        self.run_pages("new", "..", "X", code=1)
        self.run_pages("new", "notes", "X", "--parent", "../memory/welcome", code=1)
        self.run_pages("list", "--space", "../..", code=1)

    def test_a_symlinked_space_is_refused(self):
        self.run_pages("spaces")
        outside = self.home / "outside"
        outside.mkdir()
        (outside / "space.json").write_text('{"name": "Outside"}')
        (outside / "secret.md").write_text("---\ntitle: Secret\n---\nno\n")
        os.symlink(outside, self.spaces / "linked")
        self.assertNotIn("linked", [s["slug"] for s in self.json_of("spaces")])
        self.assertIn("outside the spaces folder", self.run_pages("show", "linked/secret", code=1).stderr)

    def test_publish_takes_only_files_in_the_drafts_folder(self):
        self.run_pages("spaces")
        stray = self.home / "ob_000000000000.md"
        stray.write_text("---\ntitle: X\nspace: notes\n---\nx\n")
        self.run_pages("publish", str(stray), code=1)
        self.run_pages("publish", str(self.spaces / "notes" / "welcome.md"), code=1)
        self.run_pages("publish", "ob_ffffffffffff", code=1)

    # ------------------------------------------------------------ drafts and publish

    def test_draft_writes_the_draft_and_the_outbox_page_item(self):
        self.run_pages("spaces")
        item = self.json_of("draft", "notes", "Release notes", "--worker", "scribe", "--from", "-",
                            stdin="# Release notes\n\n- Faster sync\n- [x] Fixed login\n")
        self.assertRegex(item["id"], r"^ob_[0-9a-f]{12}$")
        self.assertEqual(item["kind"], "page")
        self.assertTrue(item["needs_approval"])
        self.assertEqual(item["space"], "notes")
        self.assertNotIn("page", item)
        self.assertTrue(item["body"].startswith("New page in Notes\n\n"))
        self.assertIn("Faster sync", item["body"])
        draft = Path(item["draft_path"])
        self.assertEqual(draft, self.spaces / ".drafts" / f"{item['id']}.md")
        meta, body = self.front(draft)
        self.assertEqual((meta["title"], meta["by"], meta["space"], meta["id"]),
                         ("Release notes", "scribe", "notes", item["id"]))
        self.assertIn("created", meta)
        self.assertIn("updated", meta)
        self.assertEqual(body, "# Release notes\n\n- Faster sync\n- [x] Fixed login\n")
        self.assertEqual(self.outbox("scribe"), [item])
        # Nothing landed in the space yet.
        self.assertFalse((self.spaces / "notes" / "release-notes.md").exists())

    def test_draft_appends_after_an_outbox_line_with_no_newline(self):
        self.run_pages("spaces")
        box = self.call / "outbox"
        box.mkdir()
        (box / "scribe.jsonl").write_text('{"at": "2026-01-01T00:00:00Z", "kind": "note", "title": "old"}')
        self.run_pages("draft", "notes", "T", "--worker", "scribe", "--from", "-", stdin="x\n")
        lines = (box / "scribe.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[1])["kind"], "page")

    def test_draft_permissions_and_inputs(self):
        self.run_pages("spaces")
        self.assertIn("may not write to 'memory'", self.run_pages(
            "draft", "memory", "Tone", "--worker", "scribe", "--from", "-", stdin="x", code=4).stderr)
        # No `spaces` in the registry: Notes only.
        self.run_pages("draft", "notes", "Ok", "--worker", "scout", "--from", "-", stdin="x")
        self.run_pages("draft", "memory", "No", "--worker", "scout", "--from", "-", stdin="x", code=4)
        # "*" opens every space.
        self.run_pages("draft", "memory", "Tone", "--worker", "keeper", "--from", "-", stdin="Short replies.")
        self.assertIn("No worker 'ghost'", self.run_pages(
            "draft", "notes", "X", "--worker", "ghost", "--from", "-", stdin="x", code=4).stderr)
        self.run_pages("draft", "notes", "X", "--worker", "Bad Key", "--from", "-", stdin="x", code=2)
        self.assertIn("needs content", self.run_pages(
            "draft", "notes", "X", "--worker", "scribe", "--from", "-", stdin="  \n", code=2).stderr)
        self.run_pages("draft", "notes", "X", "--worker", "scribe", code=2)  # no content at all
        self.run_pages("draft", "notes/nope", "X", "--worker", "scribe", "--from", "-", stdin="x", code=1)
        self.run_pages("draft", "notes", "X", "--from", "-", stdin="x", code=2)  # --worker is required
        self.assertIn("100,000", self.run_pages(
            "draft", "notes", "Big", "--worker", "scribe", "--from", "-", stdin="x" * 100_001, code=1).stderr)

    def test_publish_saves_a_new_page_once_and_removes_the_draft(self):
        self.run_pages("spaces")
        self.run_pages("new", "notes", "Release notes")  # the slug is taken: the draft lands beside it
        item = self.json_of("draft", "notes", "Release notes", "--worker", "scribe", "--parent", "welcome",
                            "--from", "-", stdin="Body\n")
        receipt = self.json_of("publish", item["draft_path"], "--space", "notes")
        self.assertEqual((receipt["space"], receipt["page"]), ("notes", "release-notes-2"))
        meta, body = self.front(self.spaces / "notes" / "release-notes-2.md")
        self.assertEqual((meta["title"], meta["by"], meta["parent"]), ("Release notes", "scribe", "welcome"))
        for key in ("space", "id", "page", "base_updated", "base_hash"):
            self.assertNotIn(key, meta)
        self.assertEqual(body, "Body\n")
        self.assertFalse(Path(item["draft_path"]).exists())
        # Approved twice (two panes, a retry): the same page, no second copy.
        again = self.json_of("publish", item["draft_path"], "--space", "notes")
        self.assertTrue(again["already"])
        self.assertEqual(again["page"], "release-notes-2")
        self.assertEqual(self.run_pages("publish", item["id"]).stdout.strip(),
                         "Already published: notes/release-notes-2")
        self.assertFalse((self.spaces / "notes" / "release-notes-3.md").exists())

    def test_publish_refuses_a_space_other_than_the_drafts(self):
        self.run_pages("spaces")
        self.run_pages("mkspace", "Other")
        item = self.json_of("draft", "notes", "T", "--worker", "scribe", "--from", "-", stdin="x")
        self.assertIn("is for space 'notes'", self.run_pages(
            "publish", item["draft_path"], "--space", "other", code=1).stderr)
        self.assertTrue(Path(item["draft_path"]).exists())

    def test_publish_revises_a_page_and_keeps_its_created_and_extra_keys(self):
        self.run_pages("spaces")
        self.run_pages("new", "notes", "Plan", "--from", "-", stdin="v1\n")
        page = self.spaces / "notes" / "plan.md"
        page.write_text(page.read_text().replace("by: you\n", "by: you\ntags: launch\n"))
        before, _ = self.front(page)
        item = self.json_of("draft", "notes/plan", "", "--worker", "scribe", "--from", "-", stdin="v2\n")
        self.assertEqual(item["page"], "plan")
        self.assertEqual(item["title"], "Plan")  # an empty title keeps the page's own
        self.assertTrue(item["body"].startswith("Revision of Notes / Plan"))
        time.sleep(0.01)
        self.run_pages("publish", item["id"], "--space", "notes")
        after, body = self.front(page)
        self.assertEqual(body, "v2\n")
        self.assertEqual(after["created"], before["created"])
        self.assertNotEqual(after["updated"], before["updated"])
        self.assertEqual((after["by"], after["tags"]), ("scribe", "launch"))

    def test_publish_refuses_a_stale_draft_unless_forced(self):
        self.run_pages("spaces")
        self.run_pages("new", "notes", "Plan", "--from", "-", stdin="v1\n")
        page = self.spaces / "notes" / "plan.md"
        first = self.json_of("draft", "notes/plan", "Plan", "--worker", "scribe", "--from", "-", stdin="from A\n")
        second = self.json_of("draft", "notes/plan", "Plan", "--worker", "scribe", "--from", "-", stdin="from B\n")
        time.sleep(0.01)
        self.run_pages("publish", first["id"])
        err = self.run_pages("publish", second["id"], code=3).stderr
        self.assertIn("changed after this draft was made", err)
        self.assertEqual(self.front(page)[1], "from A\n")
        self.assertTrue(Path(second["draft_path"]).exists())
        self.run_pages("publish", second["id"], "--force")
        self.assertEqual(self.front(page)[1], "from B\n")

    def test_an_owner_edit_in_the_editor_also_makes_a_draft_stale(self):
        self.run_pages("spaces")
        self.run_pages("new", "notes", "Plan", "--from", "-", stdin="v1\n")
        page = self.spaces / "notes" / "plan.md"
        item = self.json_of("draft", "notes/plan", "Plan", "--worker", "scribe", "--from", "-", stdin="v2\n")
        page.write_text(page.read_text() + "the owner's own line\n")  # `updated` unchanged
        self.run_pages("publish", item["id"], code=3)
        self.assertIn("the owner's own line", page.read_text())

    def test_a_page_removed_after_its_draft_needs_force(self):
        self.run_pages("spaces")
        self.run_pages("new", "notes", "Plan")
        item = self.json_of("draft", "notes/plan", "Plan", "--worker", "scribe", "--from", "-", stdin="v2\n")
        (self.spaces / "notes" / "plan.md").unlink()
        self.assertIn("was removed", self.run_pages("publish", item["id"], code=3).stderr)
        self.run_pages("publish", item["id"], "--force")
        self.assertEqual(self.front(self.spaces / "notes" / "plan.md")[1], "v2\n")

    def test_a_vanished_parent_lands_the_page_at_the_top_level(self):
        self.run_pages("spaces")
        self.run_pages("new", "notes", "Parent")
        item = self.json_of("draft", "notes", "Child", "--worker", "scribe", "--parent", "parent",
                            "--from", "-", stdin="x\n")
        (self.spaces / "notes" / "parent.md").unlink()
        proc = self.run_pages("publish", item["id"])
        self.assertIn("saved at the top level", proc.stderr)
        self.assertNotIn("parent", self.front(self.spaces / "notes" / "child.md")[0])

    def test_front_matter_round_trips_risky_titles(self):
        self.run_pages("spaces")
        for title in ['Q3: plan', '#1 priority', 'yes', '2026', '"quoted"', "it's", 'a # b', '- dash', 'ends:']:
            out = self.json_of("new", "notes", title)
            self.assertEqual(self.json_of("show", f"notes/{out['slug']}")["title"], title)


if __name__ == "__main__":
    unittest.main()
