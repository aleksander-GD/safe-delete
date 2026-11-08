import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Trashed } from '../types'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const items = atom({ plugin: 'safe-delete', key: 'items' } as const, [], { shape: 'items-1' })
const logRead = atom({ plugin: 'safe-delete', key: 'logRead' } as const, 0)
const isHidden = atom({ plugin: 'safe-delete', key: 'isHidden' } as const, false)
const armed = atom({ plugin: 'safe-delete', key: 'armed' } as const, null as string | null)
const previewing = atom({ plugin: 'safe-delete', key: 'previewing' } as const, null as string | null)

const PANE = 'trash-preview'
const MAX_PREVIEW_BYTES = 512 * 1024
const MAX_PREVIEW_LINES = 400

type Preview =
  | { kind: 'text'; lines: string[]; total: number }
  | { kind: 'folder'; entries: { name: string; isFolder: boolean }[] }
  | { kind: 'note'; text: string }

type Engine = EngineInterface

const US = '\u001f'
const RS = '\u001e'

// A command word that rm, rmdir or unlink is, where the shim's functions catch it.
const MENTIONS_DELETE = /(^|[\s;&|()`{!])(rm|rmdir|unlink)(?=$|[\s;&|)`}])/

// Ways to delete that a shell function cannot catch: refused, with the way that can.
const BYPASSES: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /(^|[\s;&|(`])\\(rm|rmdir|unlink)(?=$|\s)/, what: 'a backslash-escaped rm' },
  { pattern: /(^|[\s;&|(`=])(\/usr)?\/bin\/(rm|rmdir|unlink)(?=$|\s)/, what: 'rm by its absolute path' },
  {
    pattern: /(^|[\s;&|(`])(command|builtin|exec|sudo|doas|nohup|env|xargs|parallel)\b[^;&|\n]*?(^|\s)(rm|rmdir|unlink)(?=$|\s)/,
    what: 'rm run through another program (sudo, xargs, env, command, ...)',
  },
  { pattern: /\bfind\b[^;&|\n]*\s-delete\b/, what: 'find -delete' },
  { pattern: /\bfind\b[^;&|\n]*\s-exec(dir)?\s+(\S*\/)?(rm|rmdir|unlink)(?=$|\s)/, what: 'find -exec rm' },
  { pattern: /\b(ba|z|da|k)?sh\s+-c\b[^\n]*(^|[\s'"])(rm|rmdir|unlink)(?=$|[\s'"])/, what: 'rm inside a nested shell' },
]
const GIT_CLEAN = /\bgit\s+clean\b(?![^;&|\n]*\s(-n|--dry-run|-[a-zA-Z]*n[a-zA-Z]*)\b)/

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

const dirname = (path: string): string => {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')

  return cut <= 0 ? '/' : path.slice(0, cut)
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

// Module values start over on a reload; each is rebuilt from `$` on demand.
let paths: { log: string; shim: string } | undefined
let cwd = ''
let home = ''
const rewritten = new Map<string, string>()
// What sits in the Trash does not change, so each preview is read once.
const previews = new Map<string, Preview>()

async function ensurePaths($: Engine): Promise<{ log: string; shim: string }> {
  if (paths) {
    return paths
  }

  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '') || '/tmp'
  const session = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '')
  const folder = `${tmp}/safe-delete`
  const log = `${folder}/${session}.log`
  const shim = `${folder}/${session}.shim.sh`
  const script = `${$.plugin.root}/scripts/trash.sh`
  const run = (cmd: string): string =>
    `function ${cmd} { /bin/sh ${shellQuote(script)} ${shellQuote(log)} ${cmd} "$@"; }`

  await $.fs.write(
    shim,
    [
      '# safe-delete: rm, rmdir and unlink move to the Trash instead of deleting.',
      'unalias rm 2>/dev/null',
      'unalias rmdir 2>/dev/null',
      'unalias unlink 2>/dev/null',
      run('rm'),
      run('rmdir'),
      run('unlink'),
      '',
    ].join('\n')
  )
  paths = { log, shim }

  return paths
}

// Reads what the shim recorded since last time into the restorable list.
async function ingest($: Engine): Promise<Trashed[]> {
  const { log } = await ensurePaths($)

  if (!(await $.fs.exists(log))) {
    return []
  }

  const text = await $.fs.read(log)
  const from = await read($, logRead)

  if (text.length <= from) {
    return []
  }

  const now = await $.clock.now()
  const added = text
    .slice(from)
    .split(RS)
    .filter(record => record.length > 0)
    .flatMap((record, index): Trashed[] => {
      const [kind, original, trashed, at] = record.split(US)

      if (!original || !trashed || (kind !== 'file' && kind !== 'folder')) {
        return []
      }

      return [{ id: `${now}-${from}-${index}`, original, trashed, kind, at: Number(at) || 0 }]
    })

  await update($, logRead, () => text.length)

  if (added.length > 0) {
    await update($, items, list => [...list, ...added])
    await update($, isHidden, () => false)
  }

  return added
}

const display = (path: string): string => {
  if (cwd && path.startsWith(`${cwd}/`)) {
    return path.slice(cwd.length + 1)
  }

  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

// The folder an item lived in, short enough to sit beside its name in the band.
const shortFolder = (path: string): string => {
  const folder = dirname(path)

  if (cwd && folder === cwd) {
    return 'project root'
  }

  const shown = display(folder)

  if (shown.length <= 40) {
    return shown
  }

  const segments = shown.split('/').filter(Boolean)
  const lastTwo = `…/${segments.slice(-2).join('/')}`

  return lastTwo.length <= 40 ? lastTwo : `…/${segments.at(-1) ?? ''}`
}

const isInTrash = (path: string): boolean => /\/\.Trash\/[^/]|\/Trash\/files\/[^/]/.test(path)

// Deletes one item from the Trash for good; answers why not, or undefined.
async function deleteOne($: Engine, item: Trashed): Promise<string | undefined> {
  if (!isInTrash(item.trashed)) {
    return `${basename(item.original)}: not in a Trash folder, left alone`
  }

  if (await $.fs.exists(item.trashed)) {
    const removed = await $.process.run(['/bin/rm', '-rf', '--', item.trashed])

    if (removed.exitCode !== 0) {
      return `${basename(item.original)}: ${removed.stderr.trim() || 'could not delete it'}`
    }
  }

  const infoFile = item.trashed.replace(/\/Trash\/files\/([^/]+)$/, '/Trash/info/$1.trashinfo')

  if (infoFile !== item.trashed) {
    await $.process.run(['/bin/rm', '-f', '--', infoFile])
  }

  await update($, items, list => list.filter(one => one.id !== item.id))

  return undefined
}

// The first press arms the Delete, the second (on the same target) deletes.
async function pressDelete($: Engine, target: string, chosen: readonly Trashed[]): Promise<void> {
  if ((await read($, armed)) !== target) {
    await update($, armed, () => target)

    return
  }

  await update($, armed, () => null)
  const failed: string[] = []

  for (const item of chosen) {
    const why = await deleteOne($, item)

    if (why !== undefined) {
      failed.push(why)
    }
  }

  const done = chosen.length - failed.length
  await closeStalePreview($)
  $.ui.toast(
    failed.length > 0
      ? `Deleted ${done}, ${failed.length} failed: ${failed[0]}`
      : `Deleted ${chosen.length === 1 ? basename(chosen[0]?.original ?? '') : plural(done, 'item', 'items')} permanently`
  )
}

// Moves one item back where it was; answers why not, or undefined.
async function restoreOne($: Engine, item: Trashed): Promise<string | undefined> {
  if (await $.fs.exists(item.original)) {
    return `${display(item.original)}: something already exists there`
  }

  if (!(await $.fs.exists(item.trashed))) {
    await update($, items, list => list.filter(one => one.id !== item.id))

    return `${display(item.original)}: no longer in the Trash`
  }

  await $.process.run(['/bin/mkdir', '-p', dirname(item.original)])
  const moved = await $.process.run(['/bin/mv', '-n', item.trashed, item.original])

  if (moved.exitCode !== 0 || !(await $.fs.exists(item.original))) {
    return `${display(item.original)}: ${moved.stderr.trim() || 'could not move it back'}`
  }

  const infoFile = item.trashed.replace(/\/Trash\/files\/([^/]+)$/, '/Trash/info/$1.trashinfo')

  if (infoFile !== item.trashed) {
    await $.process.run(['/bin/rm', '-f', infoFile])
  }

  await update($, items, list => list.filter(one => one.id !== item.id))

  return undefined
}

async function restoreMany($: Engine, chosen: readonly Trashed[]): Promise<{ done: Trashed[]; failed: string[] }> {
  const done: Trashed[] = []
  const failed: string[] = []

  // Newest first, so a folder trashed after its own files comes back before them.
  for (const item of [...chosen].reverse()) {
    const why = await restoreOne($, item)

    if (why === undefined) {
      done.push(item)
    } else {
      failed.push(why)
    }
  }

  return { done, failed }
}

const summary = ({ done, failed }: { done: Trashed[]; failed: string[] }): string => {
  const lines = [
    done.length > 0 ? `Restored ${plural(done.length, 'item', 'items')}:` : 'Nothing was restored.',
    ...done.map(item => `  ${display(item.original)}`),
    ...(failed.length > 0 ? ['Could not restore:', ...failed.map(why => `  ${why}`)] : []),
  ]

  return lines.join('\n')
}

const noteForModel = (done: readonly Trashed[]): string =>
  `The user restored from the Trash (safe-delete): ${done.map(item => item.original).join(', ')}. ` +
  'These files and folders exist again.'

const formatSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

async function loadPreview($: Engine, item: Trashed): Promise<Preview> {
  const cached = previews.get(item.id)

  if (cached) {
    return cached
  }

  let preview: Preview

  try {
    if (item.kind === 'folder') {
      const entries = (await $.fs.list(item.trashed))
        .map(entry => ({ name: entry.name, isFolder: entry.kind === 'dir' }))
        .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name))
      preview = { kind: 'folder', entries }
    } else {
      const { size } = await $.fs.stat(item.trashed)

      if (size > MAX_PREVIEW_BYTES) {
        preview = { kind: 'note', text: `Too large to preview (${formatSize(size)}).` }
      } else {
        const text = await $.fs.read(item.trashed)

        if (text.includes('\u0000')) {
          preview = { kind: 'note', text: `Binary file (${formatSize(size)}), no text to show.` }
        } else if (text.length === 0) {
          preview = { kind: 'note', text: 'Empty file.' }
        } else {
          const lines = text.replace(/\n$/, '').split('\n')
          preview = { kind: 'text', lines: lines.slice(0, MAX_PREVIEW_LINES), total: lines.length }
        }
      }
    }
  } catch (error) {
    return { kind: 'note', text: `Could not read it: ${error instanceof Error ? error.message : String(error)}` }
  }

  previews.set(item.id, preview)

  return preview
}

// A click on a name shows it in the pane; a click on the name shown closes the pane.
async function pressPreview($: Engine, item: Trashed): Promise<void> {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  const current = await read($, previewing)

  if (isOpen && current === item.id) {
    await update($, previewing, () => null)
    await $.ui.close({ id: PANE })

    return
  }

  await update($, previewing, () => item.id)
  await $.ui.open({ id: PANE, title: basename(item.original) })
}

// Closes the pane once the item it shows has been restored or deleted.
async function closeStalePreview($: Engine): Promise<void> {
  const current = await read($, previewing)

  if (current === null || (await read($, items)).some(item => item.id === current)) {
    return
  }

  previews.delete(current)
  await update($, previewing, () => null)
  await $.ui.close({ id: PANE })
}

async function pressRestore($: Engine, chosen: readonly Trashed[]): Promise<void> {
  await update($, armed, () => null)
  const result = await restoreMany($, chosen)
  await closeStalePreview($)

  $.ui.toast(
    result.failed.length > 0
      ? `Restored ${result.done.length}, ${result.failed.length} failed: ${result.failed[0]}`
      : `Restored ${plural(result.done.length, 'item', 'items')} from the Trash`
  )

  if (result.done.length > 0) {
    await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: noteForModel(result.done) }] } })
      .catch(() => undefined)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    home = ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
    await $.command.register({
      name: 'restore',
      description: 'Restore files and folders safe-delete moved to the Trash',
      argumentHint: '[all | list | <number> ... | <path>]',
    })
    await ensurePaths($).catch(() => undefined)

    return next(e)
  })

  // Every rm, rmdir and unlink the Bash tool runs goes through the shim.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command

    if (GIT_CLEAN.test(command)) {
      return {
        deny:
          'safe-delete: `git clean` deletes untracked files for good. List them with `git clean -n`, ' +
          'then remove them with plain `rm` so they go to the Trash and can be restored.',
      }
    }

    const bypass = BYPASSES.find(one => one.pattern.test(command))

    if (bypass) {
      return {
        deny:
          `safe-delete: this command deletes with ${bypass.what}, which would skip the Trash. ` +
          'Use plain `rm`, `rmdir` or `unlink` at the top level of the command (a loop or `$(...)` is fine): ' +
          'those move what they name to the Trash, where the user can restore it.',
      }
    }

    if (!MENTIONS_DELETE.test(command)) {
      return next(e)
    }

    const { shim } = await ensurePaths($)
    rewritten.set(e.tool_use_id, command)
    const ran = await next({ ...e, command: `. ${shellQuote(shim)} && ${command}` })
    rewritten.delete(e.tool_use_id)
    const added = await ingest($)

    if (added.length === 0 || ran.deny !== undefined) {
      return ran
    }

    const note =
      `safe-delete moved ${plural(added.length, 'item', 'items')} to the Trash instead of deleting ` +
      `(the user can restore them with /restore): ${added.map(item => item.original).join(', ')}`

    return { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => {
    if (next.called) {
      return next(e)
    }

    return MENTIONS_DELETE.test(e.command)
      ? { deny: 'safe-delete could not route this deletion to the Trash, so it did not run.' }
      : next(e)
  })

  // The permission check judges the command as the model wrote it, not the shim's prefix:
  // a deny of the real call stands, otherwise the verdict is the original command's.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const original = e.tool_use_id === undefined ? undefined : rewritten.get(e.tool_use_id)
    const actual = await next(e)

    if (original === undefined || actual.decision === 'deny' || typeof e.input !== 'object' || e.input === null) {
      return actual
    }

    return $.tool.check({ tool: 'Bash', input: { ...e.input, command: original } })
  })

  // Background commands record their moves after the call returns.
  on('turn.complete', async ($, e, next) => {
    await ingest($).catch(() => undefined)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await ingest($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'restore' }, async ($, e) => {
    await ingest($).catch(() => undefined)
    const list = await read($, items)
    const newestFirst = [...list].reverse()
    const args = e.args.trim()

    if (list.length === 0) {
      return { text: 'Nothing to restore: safe-delete has not moved anything to the Trash this session.' }
    }

    if (args === 'list') {
      const lines = newestFirst.map(
        (item, index) => `  ${index + 1}. ${item.kind === 'folder' ? '[folder]' : '[file]  '} ${display(item.original)}`
      )

      return {
        text: [`In the Trash (newest first):`, ...lines, '', 'Restore with /restore <number> or /restore all.'].join(
          '\n'
        ),
      }
    }

    let chosen: Trashed[]

    if (args === '' || args === 'all') {
      chosen = list
    } else if (/^\d+(\s+\d+)*$/.test(args)) {
      const numbers = args.split(/\s+/).map(Number)
      const bad = numbers.filter(number => number < 1 || number > newestFirst.length)

      if (bad.length > 0) {
        return { text: `No item ${bad.join(', ')}: /restore list shows ${newestFirst.length}.` }
      }

      const picked = new Set(numbers.flatMap(number => newestFirst[number - 1]?.id ?? []))
      chosen = list.filter(item => picked.has(item.id))
    } else {
      const wanted = args.replace(/\/+$/, '')
      const absolute = wanted.startsWith('/') ? wanted : `${cwd}/${wanted.replace(/^\.\//, '')}`
      chosen = list.filter(
        item => item.original === absolute || item.original === wanted || item.original.endsWith(`/${wanted}`)
      )

      if (chosen.length === 0) {
        return { text: `Nothing in safe-delete's list matches ${wanted}. /restore list shows what can be restored.` }
      }
    }

    const result = await restoreMany($, chosen)

    return {
      text: summary(result),
      ...(result.done.length > 0 ? { context: [noteForModel(result.done)] } : {}),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, items)

    if (e.props.hasSurvey || list.length === 0 || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const newestFirst = [...list].reverse()
    const room = Math.max(1, Math.min(8, e.props.maxRows - 2))
    const shown = newestFirst.slice(0, room)
    const hiddenCount = newestFirst.length - shown.length
    const armedId = await read($, armed)
    const previewId = (await $.ui.panes()).some(pane => pane.id === PANE) ? await read($, previewing) : null

    return (
      <Box flexDirection='column'>
        <Box flexDirection='row' gap={1}>
          <Text bold>Moved to Trash</Text>
          <Text dimColor>{plural(list.length, 'item', 'items')}</Text>
          <Button
            key='restore-all'
            label='Restore all'
            hotkey='a'
            variant='primary'
            onPress={() => void pressRestore($, list)}
          />
          <Button
            key='delete-all'
            label={armedId === 'all' ? 'Delete all for good?' : 'Delete all'}
            dimColor={armedId !== 'all'}
            onPress={() => void pressDelete($, 'all', list)}
          />
          <Button key='dismiss' label='Hide' role='dismiss' onPress={() => void update($, isHidden, () => true)} />
        </Box>
        {shown.map((item, index) => (
          <Box key={item.id} flexDirection='row' gap={1}>
            <Button
              key={`restore:${item.id}`}
              label='Restore'
              dimColor
              {...(index < 9 ? { hotkey: String(index + 1) } : {})}
              onPress={() => void pressRestore($, [item])}
            />
            <Button
              key={`delete:${item.id}`}
              label={armedId === item.id ? 'Delete for good?' : 'Delete'}
              dimColor={armedId !== item.id}
              onPress={() => void pressDelete($, item.id, [item])}
            />
            <Button
              key={`open:${item.id}`}
              label={`${previewId === item.id ? '▸ ' : ''}${item.kind === 'folder' ? `${basename(item.original)}/` : basename(item.original)}`}
              plain
              onPress={() => void pressPreview($, item)}
            />
            <Text dimColor wrap='truncate-start'>{`in ${shortFolder(item.original)}`}</Text>
          </Box>
        ))}
        {hiddenCount > 0 && <Text dimColor>{`+${hiddenCount} more: /restore list`}</Text>}
      </Box>
    )
  })

  // Closed from the pane's own mark or key: the band stops marking the name.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, previewing, () => null)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const id = await read($, previewing)
    const item = (await read($, items)).find(one => one.id === id)

    if (!item) {
      return <Text dimColor>Nothing to preview: click a name in the Moved to Trash bar.</Text>
    }

    const preview = await loadPreview($, item)
    const width = String(preview.kind === 'text' ? preview.lines.length : 0).length

    return (
      <Box flexDirection='column'>
        <Text bold wrap='truncate-end'>
          {item.kind === 'folder' ? `${basename(item.original)}/` : basename(item.original)}
        </Text>
        <Text dimColor wrap='truncate-start'>{`was ${display(item.original)}`}</Text>
        <Box flexDirection='row' gap={1} marginTop={1} marginBottom={1}>
          <Button key='pane-restore' label='Restore' variant='primary' onPress={() => void pressRestore($, [item])} />
          <Button key='pane-close' label='Close' onPress={() => void pressPreview($, item)} />
        </Box>
        {preview.kind === 'note' && <Text dimColor>{preview.text}</Text>}
        {preview.kind === 'folder' && preview.entries.length === 0 && <Text dimColor>Empty folder.</Text>}
        {preview.kind === 'folder' &&
          preview.entries.map(entry => (
            <Text wrap='truncate-end'>{entry.isFolder ? `${entry.name}/` : entry.name}</Text>
          ))}
        {preview.kind === 'text' &&
          preview.lines.map((line, index) => (
            <Text wrap='truncate-end'>
              <Text dimColor>{`${String(index + 1).padStart(width)}  `}</Text>
              {line.replaceAll('\t', '  ') || ' '}
            </Text>
          ))}
        {preview.kind === 'text' && preview.total > preview.lines.length && (
          <Text dimColor>{`… ${preview.total - preview.lines.length} more lines`}</Text>
        )}
      </Box>
    )
  })
}
