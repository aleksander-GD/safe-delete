import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'safe-delete',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 11 },
    view: {},
  },
} as const

const ITEMS = [
  { id: 'one', original: '/work/dist', trashed: '/home/.Trash/dist', kind: 'folder', at: 1 },
  { id: 'two', original: '/work/notes.txt', trashed: '/home/.Trash/notes.txt', kind: 'file', at: 2 },
]

test('rm is routed through the shim, and find -delete is refused', async ($, on) => {
  const ran: string[] = []
  on('session.id', () => ({ value: 'abc' }))
  on('env.get', () => ({ value: '/tmp/' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash') ran.push(e.command)

    return { result: {} }
  })

  await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
  expect(ran.at(-1)).toBe(`. '/tmp/safe-delete/abc.shim.sh' && rm -rf dist`)

  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(ran.at(-1)).toBe('ls -la')

  const refused = await $.tool.call({ tool: 'Bash', command: 'find . -name "*.log" -delete' })
  expect(refused.deny).toContain('find -delete')

  const sudo = await $.tool.call({ tool: 'Bash', command: 'sudo rm -rf build' })
  expect(sudo.deny).toContain('safe-delete')

  const clean = await $.tool.call({ tool: 'Bash', command: 'git clean -fd' })
  expect(clean.deny).toContain('git clean')

  const dry = await $.tool.call({ tool: 'Bash', command: 'git clean -n' })
  expect(dry.deny).toBe(undefined)
})

test('the band lists each trashed item with its own Restore, and Restore all', async ($, on) => {
  on('state.get', (_, e) => ({
    value: e.key === 'items' ? { value: { shape: 'items-1', value: ITEMS }, version: 1 } : { value: undefined, version: 0 },
  }))
  on('ui.panes', () => ({ value: [] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /Moved to Trash/ }))?.text).toBe('Moved to Trash')
    expect(await ui.find({ type: 'Button', key: 'restore-all' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'restore:one' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'restore:two' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'delete:two' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'delete-all' })).toBeTruthy()
    expect((await ui.find({ type: 'Button', key: 'open:two' }))?.text).toBe('notes.txt')
    expect((await ui.find({ type: 'Button', key: 'open:one' }))?.text).toBe('dist/')
    expect((await ui.find({ type: 'Text', text: /in \/work/ }))?.text).toBe('in /work')
    await ui.unmount()
  }
})

test('Delete asks for a second press before deleting', async ($, on) => {
  let stored: unknown = null
  let version = 1
  const removed: string[][] = []
  on('state.get', (_, e) => ({
    value:
      e.key === 'items'
        ? { value: { shape: 'items-1', value: ITEMS }, version: 1 }
        : e.key === 'armed'
          ? { value: stored, version }
          : { value: undefined, version: 0 },
  }))
  on('state.set', (_, e) => {
    if (e.key === 'armed') {
      stored = e.value
      version += 1
    }

    return { value: { isSet: true as const, version } }
  })
  on('fs.exists', () => ({ value: true }))
  on('ui.panes', () => ({ value: [] }))
  on('process.run', (_, e) => {
    removed.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'delete:two' })
  expect(removed.length).toBe(0)
  expect(stored).toBe('two')
  await ui.unmount()
})

test('the band stays empty when nothing was trashed', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

const PANE = {
  plugin: 'safe-delete',
  component: 'Pane',
  requestId: 'trash-preview',
  props: {
    title: 'notes.txt',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('clicking a name opens the pane with that file, clicking it again closes it', async ($, on) => {
  let shown: string | null = null
  let version = 1
  let isOpen = false
  on('state.get', (_, e) => ({
    value:
      e.key === 'items'
        ? { value: { shape: 'items-1', value: ITEMS }, version: 1 }
        : e.key === 'previewing'
          ? { value: shown, version }
          : { value: undefined, version: 0 },
  }))
  on('state.set', (_, e) => {
    if (e.key === 'previewing') {
      shown = e.value as string | null
      version += 1
    }

    return { value: { isSet: true as const, version } }
  })
  on('ui.panes', () => ({
    value: isOpen ? [{ id: 'trash-preview', title: 'notes.txt', isShown: true, isFocused: false, isPlaced: true as const }] : [],
  }))
  on('ui.open', () => {
    isOpen = true

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => {
    isOpen = false

    return { value: undefined }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 12, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'hello\nworld\n' }))
  on('fs.list', () => ({ value: [{ name: 'index.js', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }] }))

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'open:two' })
  expect(isOpen).toBe(true)
  expect(shown).toBe('two')

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /world/ }))?.text).toContain('world')
  await pane.unmount()

  await band.press({ key: 'open:one' })
  expect(isOpen).toBe(true)
  expect(shown).toBe('one')
  const folder = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await folder.find({ type: 'Text', text: /index\.js/ }))?.text).toBe('index.js')
  await folder.unmount()

  await band.press({ key: 'open:one' })
  expect(isOpen).toBe(false)
  expect(shown).toBe(null)
  await band.unmount()
})
