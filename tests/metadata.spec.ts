import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8')

const manifest = JSON.parse(read('package.json')) as {
  icon?: string
  files?: readonly string[]
}

describe('plugin icon metadata', () => {
  it('declares and publishes icon.svg', () => {
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.files).toContain('icon.svg')
  })

  it('keeps the icon self-contained', () => {
    const source = read('icon.svg')
    expect(source).toMatch(/<svg[\s>]/)
    expect(statSync(new URL('icon.svg', root)).size).toBeLessThanOrEqual(256 * 1024)
    expect(source).not.toMatch(/(?:xlink:)?href\s*=\s*["'](?:https?:|\/\/|\.\.)/)
  })
})
