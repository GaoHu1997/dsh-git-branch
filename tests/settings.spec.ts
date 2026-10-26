import { describe, expect, it } from 'vitest'
import { sectionOf, validateConfig } from '../src/index.ts'
import { validateRootDir } from '../src/settings.ts'

describe('validateRootDir', () => {
  it('accepts an absent or blank value (the default location)', () => {
    expect(() => validateRootDir(undefined)).not.toThrow()
    expect(() => validateRootDir('')).not.toThrow()
    expect(() => validateRootDir('   ')).not.toThrow()
  })

  it('accepts absolute paths on every platform shape', () => {
    expect(() => validateRootDir('D:\\wt')).not.toThrow()
    expect(() => validateRootDir('D:/wt')).not.toThrow()
    expect(() => validateRootDir('/wt')).not.toThrow()
    expect(() => validateRootDir('\\\\server\\share')).not.toThrow()
  })

  it('rejects a relative path', () => {
    expect(() => validateRootDir('wt/root')).toThrow(/absolute/)
  })
})

describe('config section shapes', () => {
  it('spells the shipped switch defaults in the composition layer', () => {
    expect(sectionOf({})).toEqual({
      groupSidebar: true,
      fetchBeforeCreate: false,
      autoPruneWorktrees: false,
      cnAccelerate: false,
      keepWorktrees: 30,
    })
    expect(sectionOf({ groupSidebar: false, fetchBeforeCreate: true, autoPruneWorktrees: true, keepWorktrees: 5 })).toEqual({
      groupSidebar: false,
      fetchBeforeCreate: true,
      autoPruneWorktrees: true,
      cnAccelerate: false,
      keepWorktrees: 5,
    })
    expect(sectionOf({ rootDir: 'D:\\wt' })).toEqual({
      rootDir: 'D:\\wt',
      groupSidebar: true,
      fetchBeforeCreate: false,
      autoPruneWorktrees: false,
      cnAccelerate: false,
      keepWorktrees: 30,
    })
    expect(sectionOf({ postCreateCopyFiles: ['.env'] })).toEqual({
      postCreateCopyFiles: ['.env'],
      groupSidebar: true,
      fetchBeforeCreate: false,
      autoPruneWorktrees: false,
      cnAccelerate: false,
      keepWorktrees: 30,
    })
    // The URL stays ABSENT when unset (only the switch spells a default).
    expect(sectionOf({ cnAccelerate: true, cnAccelerateUrl: 'https://mirror.example/' })).toEqual({
      groupSidebar: true,
      fetchBeforeCreate: false,
      autoPruneWorktrees: false,
      cnAccelerate: true,
      cnAccelerateUrl: 'https://mirror.example/',
      keepWorktrees: 30,
    })
  })

  it('validates the switch keys and rejects unknown keys', () => {
    expect(() => validateConfig({})).not.toThrow()
    expect(() => validateConfig({ groupSidebar: false, fetchBeforeCreate: true, autoPruneWorktrees: true, keepWorktrees: 1, postCreateCopyFiles: ['.env'] })).not.toThrow()
    expect(() => validateConfig({ groupSidebar: 'yes' })).toThrow('"groupSidebar" must be a boolean')
    expect(() => validateConfig({ fetchBeforeCreate: 'yes' })).toThrow('"fetchBeforeCreate" must be a boolean')
    expect(() => validateConfig({ autoPruneWorktrees: 'yes' })).toThrow('"autoPruneWorktrees" must be a boolean')
    expect(() => validateConfig({ postCreateCopyFiles: 'not-array' as unknown as string[] })).toThrow('"postCreateCopyFiles" must be an array of strings')
    expect(() => validateConfig({ postCreateCopyFiles: [123 as unknown as string] })).toThrow('"postCreateCopyFiles" must be an array of strings')
    expect(() => validateConfig({ groupSidebar: true, nope: 1 })).toThrow('unknown key "nope"')
  })

  it('requires the cn-accelerate pair to be a boolean and an http(s) URL', () => {
    expect(() => validateConfig({ cnAccelerate: true, cnAccelerateUrl: 'https://gh-proxy.com/' })).not.toThrow()
    expect(() => validateConfig({ cnAccelerate: false })).not.toThrow()
    expect(() => validateConfig({ cnAccelerateUrl: 'https://mirror.example' })).not.toThrow()
    expect(() => validateConfig({ cnAccelerate: 'yes' })).toThrow('"cnAccelerate" must be a boolean')
    expect(() => validateConfig({ cnAccelerateUrl: 'gh-proxy.com' })).toThrow('"cnAccelerateUrl" must be an http(s) URL without whitespace')
    expect(() => validateConfig({ cnAccelerateUrl: 'ftp://mirror.example/' })).toThrow('"cnAccelerateUrl" must be an http(s) URL without whitespace')
    expect(() => validateConfig({ cnAccelerateUrl: 'https://mirror.example/a b' })).toThrow('"cnAccelerateUrl" must be an http(s) URL without whitespace')
    expect(() => validateConfig({ cnAccelerateUrl: 5 as unknown as string })).toThrow('"cnAccelerateUrl" must be an http(s) URL without whitespace')
  })

  it('requires the prune cap to be an integer >= 1', () => {
    expect(() => validateConfig({ keepWorktrees: 1 })).not.toThrow()
    expect(() => validateConfig({ keepWorktrees: 500 })).not.toThrow()
    expect(() => validateConfig({ keepWorktrees: 0 })).toThrow('integer >= 1')
    expect(() => validateConfig({ keepWorktrees: -3 })).toThrow('integer >= 1')
    expect(() => validateConfig({ keepWorktrees: 2.5 })).toThrow('integer >= 1')
    expect(() => validateConfig({ keepWorktrees: '30' })).toThrow('integer >= 1')
  })
})
