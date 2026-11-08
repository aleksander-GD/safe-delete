# safe-delete

A Claude Code mod (function hooks plugin). Git rules (gitmoji commits, git flow, PR format) are in the global `~/.claude/CLAUDE.md`; the `Gitmoji` GitHub check enforces them on PRs.

## Layout

- `.claude-plugin/plugin.json`: name, version, description, `"types": "./types/index.d.ts"`.
- `hooks/hooks.json` names one module, `hooks/register.tsx`, exporting `register(on)`.
- `types/index.d.ts`: the `$.state` contract (`interface PluginState { 'safe-delete': { ... } }`). Every state key the module uses must be declared here.
- `scripts/trash.sh`: the shim's worker, run by `/bin/sh` from the Bash tool.
- `.claude-plugin/types/` is written by the engine on each load; it is gitignored, never edit it.

## Rules the engine enforces (learned the hard way)

- **State is declared where it is used.** An `atom({ plugin, key })` must be written in the same file that reads or writes it; an atom imported from another file fails the module's load. Keep hooks and state in `register.tsx`; move layouts into plain functions in other files that take the surface's elements (`Pick<ElementTable<P>, 'Box' | 'Text' | ...>`) and plain data, never `$`.
- **One hook per event without a matcher.** A second `on('session.start', ...)` fails the load; put extra start-up work in a top-level function the one hook calls (wrap it in `.catch` if its failure must not stop the rest).
- **`$` goes only to top-level functions** of the module's own files, and is always spelled `$.noun.method(...)` at the call site.
- **Render hooks never write state.** Write from a Button's `onPress`, or from another event.
- **Module variables start over on every reload.** Anything a drawing reads goes in `$.state`; anything that must outlive the session goes in `$.store`.
- **A gating hook** (`tool.call`, `command.run`, ...) that throws is skipped; give it a `.catch` when skipping would let something through.

## Checks before every commit

```bash
claude plugin validate .
claude plugin test .
tsc -p .
```

Use the CLI the desktop app runs, `~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude`; the Homebrew `claude` can be older and validate against an older API. The only expected validator complaints are the plugin-directory ones (LICENSE, icon), which matter only for submitting to the public plugin directory.

## Tests

- `claude plugin test .` runs `tests/*.test.ts(x)` with the engine's own `$`; there is no fs, process or network. Answer each `$` call the mod makes from the test's `on`: `on('fs.exists', () => ({ value: true }))` (a call on `$` answers `{ value }`).
- Draw a component with `$.ui.mount({ plugin, surface, component, props })` and act on it by key (`press`, `find`); loop over `['terminal', 'desktop']`.
- The kit cannot close a pane the way the person does (no `ui.close` on the test's `$`); check that by hand.

## Trying a change

The mod loads from this folder in every new Claude Code session through `CLAUDE_CODE_PLUGIN_DIRS`, so whatever branch is checked out is what runs. Already-open desktop chats keep the version they started with until the app restarts.
