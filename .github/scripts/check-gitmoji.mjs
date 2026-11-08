// Checks that a PR title and its commit subjects follow the gitmoji rule:
// one official gitmoji (gitmoji.dev), a space, then a capital letter, in at
// most 72 characters. Subjects are passed as arguments, one per subject.

const GITMOJIS = [
  '🎨', '⚡️', '🔥', '🐛', '🚑️', '✨', '📝', '🚀', '💄', '🎉', '✅', '🔒️', '🔐', '🔖', '🚨',
  '🚧', '💚', '⬇️', '⬆️', '📌', '👷', '📈', '♻️', '➕', '➖', '🔧', '🔨', '🌐', '✏️',
  '💩', '⏪️', '🔀', '📦️', '👽️', '🚚', '📄', '💥', '🍱', '♿️', '💡', '🍻', '💬', '🗃️',
  '🔊', '🔇', '👥', '🚸', '🏗️', '📱', '🤡', '🥚', '🙈', '📸', '⚗️', '🔍️', '🏷️', '🌱',
  '🚩', '🥅', '💫', '🗑️', '🛂', '🩹', '🧐', '⚰️', '🧪', '👔', '🩺', '🧱', '🧑‍💻', '💸',
  '🧵', '🦺', '✈️', '🦖',
]

const MAX_LENGTH = 72

// GitHub sometimes drops the variation selector (♻️ becomes ♻), so compare without it.
const bare = text => text.replaceAll('\uFE0F', '')
const KNOWN = GITMOJIS.map(bare).sort((a, b) => b.length - a.length)

function problemWith(subject) {
  const text = bare(subject)
  const emoji = KNOWN.find(one => text.startsWith(one))
  if (emoji === undefined) return 'does not start with an official gitmoji'

  const rest = text.slice(emoji.length)
  if (!/^ \p{Lu}/u.test(rest)) return 'needs one gitmoji, a space, then a capital letter'
  if ([...subject].length > MAX_LENGTH) return `is longer than ${MAX_LENGTH} characters`

  return undefined
}

const failures = process.argv
  .slice(2)
  .map(subject => [subject, problemWith(subject)])
  .filter(([, problem]) => problem !== undefined)

for (const [subject, problem] of failures) {
  console.log(`::error::"${subject}" ${problem}`)
}

process.exit(failures.length === 0 ? 0 : 1)
