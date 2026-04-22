import * as path from 'node:path'
import {
  findConfigFile,
  readConfigFile,
  expandPath,
  ConfigFileError,
} from '../config-file'

jest.mock('node:fs')

const fs = require('node:fs') as typeof import('node:fs')

const FAKE_CWD = path.resolve('/projects/my-app')
const FAKE_HOME = path.resolve('/home/testuser')

jest.mock('node:os', () => ({
  homedir: () => FAKE_HOME,
}))

// ─── ConfigFileError ──────────────────────────────────────────────────────────

describe('ConfigFileError', () => {
  it('has code CONFIG_ERROR', () => {
    const err = new ConfigFileError('bad config')
    expect(err.code).toBe('CONFIG_ERROR')
    expect(err.name).toBe('ConfigFileError')
    expect(err.message).toBe('bad config')
    expect(err instanceof Error).toBe(true)
  })
})

// ─── findConfigFile ───────────────────────────────────────────────────────────

describe('findConfigFile', () => {
  beforeEach(() => {
    jest.resetAllMocks()
  })

  it('returns null when no config exists', () => {
    ;(fs.existsSync as jest.Mock).mockReturnValue(false)

    const result = findConfigFile(undefined, {}, FAKE_CWD)

    expect(result).toEqual({ path: null, source: 'none' })
  })

  it('finds .livyrc.json in cwd with source workspace', () => {
    const workspaceConfig = path.join(FAKE_CWD, '.livyrc.json')
    ;(fs.existsSync as jest.Mock).mockImplementation(
      (p: string) => p === workspaceConfig
    )

    const result = findConfigFile(undefined, {}, FAKE_CWD)

    expect(result).toEqual({ path: workspaceConfig, source: 'workspace' })
  })

  it('finds ~/.livy/config.json with source home', () => {
    const homeConfig = path.join(FAKE_HOME, '.livy', 'config.json')
    ;(fs.existsSync as jest.Mock).mockImplementation(
      (p: string) => p === homeConfig
    )

    const result = findConfigFile(undefined, {}, FAKE_CWD)

    expect(result).toEqual({ path: homeConfig, source: 'home' })
  })

  it('prefers workspace over home config', () => {
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)

    const result = findConfigFile(undefined, {}, FAKE_CWD)

    expect(result.source).toBe('workspace')
  })

  it('prefers explicit path over auto-discovery', () => {
    const explicit = path.resolve('/custom/livy.json')
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)

    const result = findConfigFile(explicit, {}, FAKE_CWD)

    expect(result).toEqual({ path: explicit, source: 'flag' })
  })

  it('throws ConfigFileError when explicit path does not exist', () => {
    const explicit = path.resolve('/missing/config.json')
    ;(fs.existsSync as jest.Mock).mockReturnValue(false)

    expect(() => findConfigFile(explicit, {}, FAKE_CWD)).toThrow(
      ConfigFileError
    )
    expect(() => findConfigFile(explicit, {}, FAKE_CWD)).toThrow(
      /Config file not found/
    )
  })

  it('uses LIVY_CONFIG env var when no explicit path', () => {
    const envPath = path.resolve('/env/config.json')
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)

    const result = findConfigFile(undefined, { LIVY_CONFIG: envPath }, FAKE_CWD)

    expect(result).toEqual({ path: envPath, source: 'env' })
  })

  it('throws ConfigFileError when LIVY_CONFIG env path does not exist', () => {
    const envPath = path.resolve('/env/missing.json')
    ;(fs.existsSync as jest.Mock).mockReturnValue(false)

    expect(() =>
      findConfigFile(undefined, { LIVY_CONFIG: envPath }, FAKE_CWD)
    ).toThrow(ConfigFileError)
  })
})

// ─── readConfigFile ───────────────────────────────────────────────────────────

describe('readConfigFile', () => {
  beforeEach(() => {
    jest.resetAllMocks()
  })

  it('parses valid JSON with livy/hdfs/localDeps sections', () => {
    const config = {
      livy: { serverUrl: 'http://livy:8998', authMethod: 'basic' },
      hdfs: { baseUrl: 'http://hdfs:9870', uploadPath: '/user/spark' },
      localDeps: { jars: ['app.jar'] },
    }
    ;(fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(config))

    const result = readConfigFile('/path/to/config.json')

    expect(result).toEqual(config)
    expect(fs.readFileSync).toHaveBeenCalledWith('/path/to/config.json', 'utf8')
  })

  it('accepts minimal valid config (empty object)', () => {
    ;(fs.readFileSync as jest.Mock).mockReturnValue('{}')

    const result = readConfigFile('/path/to/config.json')

    expect(result).toEqual({})
  })

  it('throws ConfigFileError on non-object JSON (array)', () => {
    ;(fs.readFileSync as jest.Mock).mockReturnValue('[1, 2, 3]')

    expect(() => readConfigFile('/cfg.json')).toThrow(ConfigFileError)
    expect(() => readConfigFile('/cfg.json')).toThrow(
      /must contain a JSON object/
    )
  })

  it('throws ConfigFileError on non-object JSON (string)', () => {
    ;(fs.readFileSync as jest.Mock).mockReturnValue('"just a string"')

    expect(() => readConfigFile('/cfg.json')).toThrow(ConfigFileError)
  })

  it('throws ConfigFileError on non-object JSON (null)', () => {
    ;(fs.readFileSync as jest.Mock).mockReturnValue('null')

    expect(() => readConfigFile('/cfg.json')).toThrow(ConfigFileError)
  })

  it('throws ConfigFileError on invalid JSON syntax', () => {
    ;(fs.readFileSync as jest.Mock).mockReturnValue('{ invalid json }')

    expect(() => readConfigFile('/cfg.json')).toThrow(ConfigFileError)
    expect(() => readConfigFile('/cfg.json')).toThrow(
      /Failed to read config file/
    )
  })

  it('throws ConfigFileError when file cannot be read', () => {
    ;(fs.readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT: no such file')
    })

    expect(() => readConfigFile('/missing.json')).toThrow(ConfigFileError)
    expect(() => readConfigFile('/missing.json')).toThrow(/ENOENT/)
  })
})

// ─── expandPath ───────────────────────────────────────────────────────────────

describe('expandPath', () => {
  it('resolves relative paths against cwd', () => {
    const result = expandPath('configs/livy.json', FAKE_CWD)

    expect(result).toBe(path.resolve(FAKE_CWD, 'configs/livy.json'))
  })

  it('resolves ~/  against home dir', () => {
    const result = expandPath('~/configs/livy.json', FAKE_CWD)

    expect(result).toBe(path.join(FAKE_HOME, 'configs/livy.json'))
  })

  it('returns absolute paths unchanged', () => {
    const abs = path.resolve('/etc/livy/config.json')
    const result = expandPath(abs, FAKE_CWD)

    expect(result).toBe(abs)
  })
})
