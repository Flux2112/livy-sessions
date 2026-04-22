import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const createSessionAndWaitMock = jest.fn()
const executeAndWaitMock = jest.fn()
const waitForBatchMock = jest.fn()
const zipDirectoryMock = jest.fn()

const livyClientMock = {
  listSessions: jest.fn(),
  createSession: jest.fn(),
  getSession: jest.fn(),
  deleteSession: jest.fn(),
  listStatements: jest.fn(),
  createStatement: jest.fn(),
  getStatement: jest.fn(),
  cancelStatement: jest.fn(),
  getLogs: jest.fn(),
  getBatchLogs: jest.fn(),
  listBatches: jest.fn(),
  createBatch: jest.fn(),
  getBatch: jest.fn(),
  getBatchState: jest.fn(),
  deleteBatch: jest.fn(),
}

const hdfsClientMock = {
  upload: jest.fn(),
  delete: jest.fn(),
}

jest.mock('@livy/core', () => {
  class LivyApiError extends Error {
    readonly statusCode: number
    readonly body: string

    constructor(statusCode: number, body: string, message?: string) {
      super(message ?? `HTTP ${statusCode}`)
      this.statusCode = statusCode
      this.body = body
    }
  }

  class ConfigFileError extends Error {
    readonly code = 'CONFIG_ERROR'
    constructor(message: string) {
      super(message)
      this.name = 'ConfigFileError'
    }
  }

  return {
    LivyClient: jest.fn().mockImplementation(() => livyClientMock),
    HdfsClient: jest.fn().mockImplementation(() => hdfsClientMock),
    LivyApiError,
    ConfigFileError,
    createSessionAndWait: (...args: unknown[]) => createSessionAndWaitMock(...args),
    executeAndWait: (...args: unknown[]) => executeAndWaitMock(...args),
    waitForBatch: (...args: unknown[]) => waitForBatchMock(...args),
    zipDirectory: (...args: unknown[]) => zipDirectoryMock(...args),
    resolveLocalDeps: jest.fn().mockResolvedValue({jars: [], pyFiles: [], files: [], archives: []}),
    findConfigFile: jest.fn().mockReturnValue({path: null, source: 'none'}),
    readConfigFile: jest.fn().mockReturnValue({}),
    expandPath: jest.fn().mockImplementation((input: string) => input),
  }
})

import BatchSubmit from '../commands/batch/submit'
import ExecRun from '../commands/exec/run'
import HdfsUploadDir from '../commands/hdfs/upload-dir'
import SessionCreate from '../commands/session/create'
import SessionKillAll from '../commands/session/kill-all'

function sampleSession(id: number, state: string, owner: string | null = 'alice'): Record<string, unknown> {
  return {
    id,
    name: '',
    appId: null,
    owner,
    proxyUser: null,
    kind: 'pyspark',
    log: [],
    state,
    appInfo: {},
    jars: [],
    pyFiles: [],
    files: [],
    driverMemory: null,
    driverCores: null,
    executorMemory: null,
    executorCores: null,
    numExecutors: null,
    archives: [],
    queue: null,
    conf: {},
    ttl: null,
  }
}

describe('CLI commands', () => {
  let stdoutSpy: jest.SpyInstance

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    jest.clearAllMocks()

    livyClientMock.listSessions.mockResolvedValue([])
    livyClientMock.createSession.mockResolvedValue(sampleSession(1, 'starting'))
    livyClientMock.getSession.mockResolvedValue(sampleSession(1, 'idle'))
    livyClientMock.deleteSession.mockResolvedValue(undefined)
    livyClientMock.listStatements.mockResolvedValue([])
    livyClientMock.createStatement.mockResolvedValue({
      id: 1,
      code: '1+1',
      state: 'running',
      output: null,
      progress: 0,
      started: 0,
      completed: 0,
    })
    livyClientMock.getStatement.mockResolvedValue({
      id: 1,
      code: '1+1',
      state: 'available',
      output: {status: 'ok', execution_count: 1, data: {'text/plain': '2'}, ename: null, evalue: null, traceback: null},
      progress: 1,
      started: 0,
      completed: 0,
    })
    livyClientMock.cancelStatement.mockResolvedValue(undefined)
    livyClientMock.getLogs.mockResolvedValue({id: 1, from: 0, size: 1, total: 1, log: ['line']})
    livyClientMock.getBatchLogs.mockResolvedValue({id: 1, from: 0, size: 1, total: 1, log: ['line']})
    livyClientMock.listBatches.mockResolvedValue([])
    livyClientMock.createBatch.mockResolvedValue({id: 11, appId: null, appInfo: {}, ttl: null, log: [], state: 'starting'})
    livyClientMock.getBatch.mockResolvedValue({id: 11, appId: null, appInfo: {}, ttl: null, log: [], state: 'success'})
    livyClientMock.getBatchState.mockResolvedValue({id: 11, state: 'success'})
    livyClientMock.deleteBatch.mockResolvedValue(undefined)

    hdfsClientMock.upload.mockResolvedValue('hdfs:///user/alice/livy-deps/test.zip')
    hdfsClientMock.delete.mockResolvedValue(undefined)

    createSessionAndWaitMock.mockResolvedValue(sampleSession(5, 'idle'))
    executeAndWaitMock.mockResolvedValue({
      id: 3,
      code: '1+1',
      state: 'available',
      output: {status: 'ok', execution_count: 1, data: {'text/plain': '2'}, ename: null, evalue: null, traceback: null},
      progress: 1,
      started: 0,
      completed: 0,
    })
    waitForBatchMock.mockResolvedValue({id: 11, appId: null, appInfo: {}, ttl: null, log: [], state: 'success'})
    zipDirectoryMock.mockResolvedValue(path.join(os.tmpdir(), 'mock-archive.zip'))
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  test('session create builds payload with additive dependencies', async () => {
    await SessionCreate.run([
      '--name',
      'agent-session',
      '--jar',
      'hdfs:///deps/a.jar',
      '--conf',
      'spark.executor.instances=2',
    ])

    expect(createSessionAndWaitMock).toHaveBeenCalledTimes(1)
    expect(createSessionAndWaitMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        kind: 'pyspark',
        name: 'agent-session',
        jars: ['hdfs:///deps/a.jar'],
        conf: {'spark.executor.instances': '2'},
      })
    )
  })

  test('exec run submits code from --code', async () => {
    await ExecRun.run(['1', '--code', '1+1'])

    expect(executeAndWaitMock).toHaveBeenCalledTimes(1)
    expect(executeAndWaitMock.mock.calls[0][1]).toBe(1)
    expect(executeAndWaitMock.mock.calls[0][2]).toEqual({code: '1+1', kind: 'pyspark'})
  })

  test('batch submit uses first --file as entry and remaining as files', async () => {
    await BatchSubmit.run([
      '--file',
      'hdfs:///apps/main.jar',
      '--file',
      'hdfs:///deps/data.txt',
      '--class-name',
      'com.example.Main',
      '--arg',
      '--mode=test',
    ])

    expect(livyClientMock.createBatch).toHaveBeenCalledTimes(1)
    expect(livyClientMock.createBatch.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        file: 'hdfs:///apps/main.jar',
        files: ['hdfs:///deps/data.txt'],
        className: 'com.example.Main',
        args: ['--mode=test'],
      })
    )
    expect(waitForBatchMock).toHaveBeenCalledTimes(1)
  })

  test('session kill-all filters by configured username unless --all is set', async () => {
    livyClientMock.listSessions.mockResolvedValue([
      sampleSession(1, 'idle', 'alice'),
      sampleSession(2, 'idle', 'bob'),
      {
        ...sampleSession(3, 'idle', null),
        proxyUser: 'alice',
      },
    ])

    await SessionKillAll.run(['--username', 'alice'])

    expect(livyClientMock.deleteSession).toHaveBeenCalledTimes(2)
    expect(livyClientMock.deleteSession).toHaveBeenNthCalledWith(1, 1, expect.anything())
    expect(livyClientMock.deleteSession).toHaveBeenNthCalledWith(2, 3, expect.anything())
  })

  test('hdfs upload-dir zips and uploads the directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livy-cli-dir-'))
    const zipPath = path.join(os.tmpdir(), 'mock-archive.zip')
    fs.writeFileSync(zipPath, 'zip', 'utf8')
    zipDirectoryMock.mockResolvedValue(zipPath)

    await HdfsUploadDir.run([
      dir,
      '--hdfs-base-url',
      'http://namenode:9870',
      '--remote-name',
      'deps.zip',
    ])

    expect(zipDirectoryMock).toHaveBeenCalledWith(dir)
    expect(hdfsClientMock.upload).toHaveBeenCalledWith(zipPath, 'deps.zip', '', expect.anything())
  })
})

