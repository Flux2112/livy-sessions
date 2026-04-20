import * as fs from 'node:fs'
import * as path from 'node:path'
import {Args, Flags} from '@oclif/core'
import {executeAndWait} from '@livy/core'
import type {LivyStatement, SessionKind, StatementState} from '@livy/core'

import {LivyBaseCommand} from '../../base-command'
import {CancelledError, ConfigError, TimeoutError} from '../../lib/config'
import {pollIntervalFlag, prettyFlag, SESSION_KIND_OPTIONS, timeoutFlag, toMilliseconds, noWaitFlag} from '../../lib/flags'
import {formatKeyValueCard, writeResult} from '../../lib/output'
import {parseId} from '../../lib/parse'
import {emitLogBatch, emitSessionRefreshed, emitStatementProgress, emitStatementSubmitted} from '../../lib/progress'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export default class ExecRun extends LivyBaseCommand {
  static override summary = 'Run code in a Livy session'
  static override flags = {
    code: Flags.string({
      description: 'Code to execute. Use "-" to read from stdin.',
    }),
    file: Flags.string({
      description: 'Path to a local file containing code to execute',
    }),
    kind: Flags.string({
      description: 'Statement kind',
      options: SESSION_KIND_OPTIONS,
    }),
    'no-wait': noWaitFlag,
    'poll-interval': pollIntervalFlag,
    timeout: timeoutFlag,
    'show-logs': Flags.boolean({
      description: 'Emit session logs as NDJSON progress events while waiting',
      default: false,
    }),
    pretty: prettyFlag,
  }

  static override args = {
    id: Args.string({
      description: 'Livy session ID',
      required: true,
    }),
  }

  public async run(): Promise<{sessionId: number; statement: LivyStatement}> {
    const {args, flags} = await this.parse(ExecRun)

    try {
      const sessionId = parseId('session id', args.id)
      const code = await resolveCodeInput(flags.code, flags.file)
      if (!code.trim()) {
        throw new ConfigError('Code input is empty')
      }

      const kind = (flags.kind ?? this.resolvedConfig.defaultKind) as SessionKind

      if (flags['no-wait']) {
        const submitted = await this.livyClient.createStatement(sessionId, {code, kind}, this.abortSignal)
        emitStatementSubmitted((event) => this.emitProgress(event), sessionId, submitted)
        const result = {sessionId, statement: submitted}
        if (!this.jsonEnabled()) {
          writeResult(this, result, {
            pretty: flags.pretty,
            renderPretty: (r) =>
              formatKeyValueCard([
                ['sessionId', r.sessionId],
                ['statementId', r.statement.id],
                ['state', r.statement.state],
              ]),
          })
        }

        return result
      }

      const statement = await executeAndWait(this.livyClient, sessionId, {code, kind}, {
        signal: this.abortSignal,
        pollIntervalMs: toMilliseconds(flags['poll-interval']) ?? this.resolvedConfig.pollIntervalMs,
        timeoutMs: toMilliseconds(flags.timeout) ?? DEFAULT_TIMEOUT_MS,
        onSubmitted: (submitted) => emitStatementSubmitted((event) => this.emitProgress(event), sessionId, submitted),
        onProgress: (current) => emitStatementProgress((event) => this.emitProgress(event), sessionId, current),
        onLogs: flags['show-logs']
          ? (logs) => emitLogBatch((event) => this.emitProgress(event), 'session', sessionId, logs)
          : undefined,
        onSessionRefreshed: (session) => emitSessionRefreshed((event) => this.emitProgress(event), session),
      })

      if (!statement) {
        throw new CancelledError()
      }

      if (!isTerminalStatementState(statement.state)) {
        throw new TimeoutError(`Timed out waiting for statement #${statement.id}`)
      }

      const result = {sessionId, statement}
      if (!this.jsonEnabled()) {
        writeResult(this, result, {
          pretty: flags.pretty,
          renderPretty: (current) => formatStatementPretty(current.statement),
        })
      }

      if (statement.state === 'error') {
        this.exit(1)
      }

      return result
    } catch (error) {
      this.failApi(error)
    }
  }
}

function isTerminalStatementState(state: StatementState): boolean {
  return state === 'available' || state === 'error' || state === 'cancelled'
}

function formatStatementPretty(statement: LivyStatement): string {
  const output = statement.output
  const preview =
    output?.status === 'ok'
      ? (output.data?.['text/plain'] ?? '')
      : `${output?.ename ?? 'Error'}: ${output?.evalue ?? ''}`

  return formatKeyValueCard([
    ['statementId', statement.id],
    ['state', statement.state],
    ['progress', statement.progress],
    ['output', preview],
  ])
}

async function resolveCodeInput(codeFlag: string | undefined, fileFlag: string | undefined): Promise<string> {
  const hasPipedStdin = !process.stdin.isTTY
  const hasCodeLiteral = codeFlag !== undefined && codeFlag !== '-'
  const hasCodeStdin = codeFlag === '-'
  const hasFile = fileFlag !== undefined
  const hasImplicitStdin = hasPipedStdin && codeFlag === undefined && fileFlag === undefined

  const selectedSources = [hasCodeLiteral, hasCodeStdin || hasImplicitStdin, hasFile].filter(Boolean).length
  if (selectedSources === 0) {
    throw new ConfigError('Provide exactly one code source: --code, --file, or stdin')
  }

  if (selectedSources > 1) {
    throw new ConfigError('Only one code source may be provided: --code, --file, or stdin')
  }

  if (hasCodeLiteral) {
    return codeFlag
  }

  if (hasFile && fileFlag) {
    const filePath = path.resolve(fileFlag)
    return fs.promises.readFile(filePath, 'utf8')
  }

  return readStdin()
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => chunks.push(chunk))
    process.stdin.on('error', reject)
    process.stdin.on('end', () => resolve(chunks.join('')))
  })
}

