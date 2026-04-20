import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {ConfigError, findConfigFile, parseAuthMethod, resolveConfig} from '../lib/config'

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('config resolution', () => {
  test('resolves precedence as flag > env > file > defaults', () => {
    const cwd = makeTempDir('livy-cli-cwd-')
    const configPath = path.join(cwd, '.livyrc.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        livy: {
          serverUrl: 'http://from-file:8998',
          authMethod: 'none',
          username: 'file-user',
        },
      }),
      'utf8'
    )

    const resolved = resolveConfig(
      {
        serverUrl: 'http://from-flag:8998',
        username: 'flag-user',
        config: configPath,
      },
      {
        LIVY_SERVER_URL: 'http://from-env:8998',
        LIVY_USERNAME: 'env-user',
      },
      cwd
    )

    expect(resolved.serverUrl).toBe('http://from-flag:8998')
    expect(resolved.username).toBe('flag-user')
    expect(resolved.configSource).toBe('flag')
    expect(resolved.configPath).toBe(configPath)
  })

  test('uses LIVY_CONFIG when provided', () => {
    const cwd = makeTempDir('livy-cli-cwd-')
    const configPath = path.join(cwd, 'custom-config.json')
    fs.writeFileSync(configPath, JSON.stringify({livy: {serverUrl: 'http://from-env-config:8998'}}), 'utf8')

    const discovered = findConfigFile(undefined, {LIVY_CONFIG: configPath}, cwd)
    expect(discovered.path).toBe(configPath)
    expect(discovered.source).toBe('env')

    const resolved = resolveConfig({}, {LIVY_CONFIG: configPath}, cwd)
    expect(resolved.serverUrl).toBe('http://from-env-config:8998')
  })

  test('validates auth requirements', () => {
    expect(() => resolveConfig({authMethod: 'basic'})).toThrow(ConfigError)
    expect(() => resolveConfig({authMethod: 'bearer'})).toThrow(ConfigError)
    expect(() => resolveConfig({authMethod: 'kerberos'})).toThrow(ConfigError)
  })

  test('parseAuthMethod rejects invalid values', () => {
    expect(parseAuthMethod('none')).toBe('none')
    expect(() => parseAuthMethod('oauth')).toThrow(ConfigError)
  })
})

