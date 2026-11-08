# safe-delete

A Claude Code mod that sends files and folders Claude deletes to the Trash instead of deleting them for good, so you can put them back.

- **`rm`, `rmdir` and `unlink`** in Claude's Bash tool move what they name to the Trash (macOS `~/.Trash`, or the freedesktop Trash on Linux), keeping the commands' own checks and exit codes.
- **Ways to delete that skip the Trash are refused**, with a note on the way that works: a backslash-escaped or absolute-path `rm`, `rm` run through `sudo`, `xargs`, `env` and similar, `find -delete`, `find -exec rm`, `rm` inside a nested shell, and `git clean` (a dry run with `-n` is allowed).
- **A "Moved to Trash" band** above the prompt lists what was moved, with **Restore**, **Delete** (asks for a second press) and **Hide**, plus **Restore all** and **Delete all**. Clicking a name previews the file or folder in a pane.
- **`/restore`** puts things back: `/restore` or `/restore all`, `/restore list`, `/restore <number> ...` or `/restore <path>`. Claude is told what came back.

## Install (every Claude Code session)

Add this folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (separate several mods with `:`), then start a new Claude Code session:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/safe-delete"
  }
}
```

For one terminal Claude Code session only: `claude --plugin-dir /path/to/safe-delete`.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
tsc -p .
```

## Commit messages

Commits and PR titles use [gitmoji](https://gitmoji.dev): one official gitmoji, a space, then an imperative subject starting with a capital letter, at most 72 characters (`🐛 Keep both limits in every Reading`). PRs are merged with a merge commit named after the PR title. The `Gitmoji` check on each PR enforces this.
