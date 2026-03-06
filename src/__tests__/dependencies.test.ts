import * as fs from 'node:fs'
import * as vscode from 'vscode'
import { registerDependencyCommands } from '../commands/dependencies'

interface ConfigState {
  username: string
  pyFiles: string[]
  jars: string[]
  files: string[]
  archives: string[]
}

function makeDirent(
  name: string,
  type: 'file' | 'dir' | 'symlink' = 'file'
): fs.Dirent {
  return {
    name,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => type === 'symlink',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as fs.Dirent
}

function createConfigMock(state: ConfigState): {
  get: <T>(key: string, defaultValue?: T) => T
  update: (key: string, value: unknown) => Promise<void>
} {
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      const value = (state as unknown as Record<string, unknown>)[key]
      if (value === undefined) {
        return defaultValue as T
      }
      return value as T
    },
    update: async (key: string, value: unknown): Promise<void> => {
      ;(state as unknown as Record<string, unknown>)[key] = value
    },
  }
}

describe('registerDependencyCommands - structured upload', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uploads mixed file/folder selections preserving relative structure', async () => {
    const state: ConfigState = {
      username: 'alice',
      pyFiles: [],
      jars: [],
      files: [],
      archives: [],
    }
    const config = createConfigMock(state)
    ;(vscode.workspace.getConfiguration as jest.Mock).mockReturnValue(config)

    const statMock = jest.spyOn(fs.promises, 'stat').mockImplementation(async (p) => {
      const full = String(p)
      return {
        isFile: () => full.endsWith('.py'),
        isDirectory: () => full === '/repo/assets',
      } as fs.Stats
    })

    const readdirMock = jest.spyOn(fs.promises, 'readdir').mockImplementation((async (p: fs.PathLike, opts: unknown) => {
      const full = String(p)
      const withTypes = typeof opts === 'object' && opts !== null && 'withFileTypes' in opts && opts.withFileTypes
      if (!withTypes) {
        return [] as unknown as fs.Dirent[]
      }
      if (full === '/repo/assets') {
        return [makeDirent('data', 'dir')] as unknown as fs.Dirent[]
      }
      if (full === '/repo/assets/data') {
        return [makeDirent('x.txt', 'file')] as unknown as fs.Dirent[]
      }
      return [] as unknown as fs.Dirent[]
    }) as any)

    const upload = jest.fn(async (_local: string, remote: string) => `hdfs:///user/alice/livy-deps/${remote}`)
    const hdfsClient = { upload, delete: jest.fn() }
    const treeProvider = { refresh: jest.fn() }

    registerDependencyCommands(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      () => hdfsClient as never,
      treeProvider as never
    )

    const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls
    const structuredRegistration = calls.find((c) => c[0] === 'livy.uploadStructuredDependencies')
    expect(structuredRegistration).toBeDefined()

    const structuredHandler = structuredRegistration?.[1] as (
      resourceUri?: vscode.Uri,
      resourceUris?: readonly vscode.Uri[]
    ) => Promise<void>

    await structuredHandler(undefined, [
      { fsPath: '/repo/src/a.py' } as vscode.Uri,
      { fsPath: '/repo/assets' } as vscode.Uri,
      { fsPath: '/repo/src/utils/b.py' } as vscode.Uri,
    ])

    expect(upload).toHaveBeenCalledTimes(3)
    expect(upload.mock.calls.map((c) => c[1])).toEqual([
      'assets/data/x.txt',
      'src/a.py',
      'src/utils/b.py',
    ])

    expect(state.files).toEqual(['hdfs:///user/alice/livy-deps/assets/data/x.txt'])
    expect(state.pyFiles).toEqual([
      'hdfs:///user/alice/livy-deps/src/a.py',
      'hdfs:///user/alice/livy-deps/src/utils/b.py',
    ])
    expect(treeProvider.refresh).toHaveBeenCalledTimes(1)

    statMock.mockRestore()
    readdirMock.mockRestore()
  })

  it('deduplicates overlapping selections between directory and nested file', async () => {
    const state: ConfigState = {
      username: 'alice',
      pyFiles: [],
      jars: [],
      files: [],
      archives: [],
    }
    const config = createConfigMock(state)
    ;(vscode.workspace.getConfiguration as jest.Mock).mockReturnValue(config)

    const statMock = jest.spyOn(fs.promises, 'stat').mockImplementation(async (p) => {
      const full = String(p)
      return {
        isFile: () => full.endsWith('.txt'),
        isDirectory: () => full === '/repo/assets',
      } as fs.Stats
    })

    const readdirMock = jest.spyOn(fs.promises, 'readdir').mockImplementation((async (p: fs.PathLike, opts: unknown) => {
      const full = String(p)
      const withTypes = typeof opts === 'object' && opts !== null && 'withFileTypes' in opts && opts.withFileTypes
      if (!withTypes) {
        return [] as unknown as fs.Dirent[]
      }
      if (full === '/repo/assets') {
        return [makeDirent('data', 'dir')] as unknown as fs.Dirent[]
      }
      if (full === '/repo/assets/data') {
        return [makeDirent('x.txt', 'file')] as unknown as fs.Dirent[]
      }
      return [] as unknown as fs.Dirent[]
    }) as any)

    const upload = jest.fn(async (_local: string, remote: string) => `hdfs:///user/alice/livy-deps/${remote}`)
    const hdfsClient = { upload, delete: jest.fn() }
    const treeProvider = { refresh: jest.fn() }

    registerDependencyCommands(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      () => hdfsClient as never,
      treeProvider as never
    )

    const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls
    const structuredHandler = calls.find((c) => c[0] === 'livy.uploadStructuredDependencies')?.[1] as (
      resourceUri?: vscode.Uri,
      resourceUris?: readonly vscode.Uri[]
    ) => Promise<void>

    await structuredHandler(undefined, [
      { fsPath: '/repo/assets' } as vscode.Uri,
      { fsPath: '/repo/assets/data/x.txt' } as vscode.Uri,
    ])

    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith(
      '/repo/assets/data/x.txt',
      'data/x.txt',
      'alice',
      expect.anything()
    )

    statMock.mockRestore()
    readdirMock.mockRestore()
  })
})
