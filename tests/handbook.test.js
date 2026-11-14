import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, validateScreens } from '../scripts/handbook/build.mjs'

const handbook = fileURLToPath(new URL('../handbook/', import.meta.url))

test('handbook images, README and redaction records are current', () => {
  const metadata = JSON.parse(readFileSync(join(handbook, 'screens.json'), 'utf8'))
  const files = validateScreens(metadata)
  expect(build(true)).toBe(readFileSync(join(handbook, 'README.md'), 'utf8'))
  const records = JSON.parse(readFileSync(join(handbook, 'redaction.json'), 'utf8')).images
  const allowFile = readFileSync(join(handbook, 'redaction-allow.json'))
  const allow = JSON.parse(allowFile)
  const allowSha256 = createHash('sha256').update(allowFile).digest('hex')
  expect(allow.version).toBe(2)
  expect(Object.keys(allow.tokens).sort()).toEqual([...files].sort())
  expect(records).toHaveLength(files.length)
  for (const file of files) {
    const matches = records.filter(item => item.file === file)
    expect(matches).toHaveLength(1)
    expect(matches[0].result).toBe('pass')
    expect(matches[0].allowSha256).toBe(allowSha256)
    expect(matches[0].sha256).toBe(createHash('sha256').update(readFileSync(join(handbook, 'screens', file))).digest('hex'))
  }
})
