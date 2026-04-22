import {Flags} from '@oclif/core'
import type {SessionKind} from '@livy/core'

import {ConfigError} from './config'

export const SESSION_KIND_OPTIONS: readonly SessionKind[] = ['spark', 'pyspark', 'sparkr', 'sql']

export const prettyFlag = Flags.boolean({
  description: 'Render human-friendly output instead of JSON',
  default: false,
})

export const noWaitFlag = Flags.boolean({
  description: 'Submit request and return immediately without polling',
  default: false,
})

export const pollIntervalFlag = Flags.integer({
  description: 'Polling interval in seconds',
  min: 1,
})

export const timeoutFlag = Flags.integer({
  description: 'Polling timeout in seconds',
  min: 1,
})

export const fromFlag = Flags.integer({
  description: 'Zero-based log offset',
  min: 0,
})

export const sizeFlag = Flags.integer({
  description: 'Maximum number of log lines to fetch per request',
  min: 1,
})

export const followFlag = Flags.boolean({
  description: 'Keep polling for new logs until cancelled',
  default: false,
})

export const sessionCreateFlags = {
  kind: Flags.string({description: 'Session kind', options: SESSION_KIND_OPTIONS}),
  name: Flags.string({description: 'Session name'}),
  'driver-memory': Flags.string({description: 'Driver memory, for example 4g'}),
  'driver-cores': Flags.integer({description: 'Driver CPU cores', min: 1}),
  'executor-memory': Flags.string({description: 'Executor memory, for example 8g'}),
  'executor-cores': Flags.integer({description: 'Executor CPU cores', min: 1}),
  'num-executors': Flags.integer({description: 'Total number of executors', min: 1}),
  ttl: Flags.string({description: 'Session TTL, for example 600m'}),
  jar: Flags.string({description: 'Additional jar URI', multiple: true}),
  'py-file': Flags.string({description: 'Additional pyFile URI', multiple: true}),
  file: Flags.string({description: 'Additional generic file URI', multiple: true}),
  archive: Flags.string({description: 'Additional archive URI', multiple: true}),
  conf: Flags.string({description: 'Spark config key=value', multiple: true}),
  'no-wait': noWaitFlag,
  'poll-interval': pollIntervalFlag,
  timeout: timeoutFlag,
  pretty: prettyFlag,
} as const

export const batchSubmitFlags = {
  file: Flags.string({
    description: 'Main batch file URI; repeat to add generic files',
    multiple: true,
    required: true,
  }),
  'class-name': Flags.string({description: 'Main class name'}),
  name: Flags.string({description: 'Batch name'}),
  'proxy-user': Flags.string({description: 'Proxy user'}),
  arg: Flags.string({description: 'Batch argument', multiple: true}),
  jar: Flags.string({description: 'Additional jar URI', multiple: true}),
  'py-file': Flags.string({description: 'Additional pyFile URI', multiple: true}),
  archive: Flags.string({description: 'Additional archive URI', multiple: true}),
  'driver-memory': Flags.string({description: 'Driver memory, for example 4g'}),
  'driver-cores': Flags.integer({description: 'Driver CPU cores', min: 1}),
  'executor-memory': Flags.string({description: 'Executor memory, for example 8g'}),
  'executor-cores': Flags.integer({description: 'Executor CPU cores', min: 1}),
  'num-executors': Flags.integer({description: 'Total number of executors', min: 1}),
  queue: Flags.string({description: 'Scheduler queue name'}),
  conf: Flags.string({description: 'Spark config key=value', multiple: true}),
  'no-wait': noWaitFlag,
  'poll-interval': pollIntervalFlag,
  timeout: timeoutFlag,
  pretty: prettyFlag,
} as const

export function parseConfEntries(values: readonly string[] | undefined): Readonly<Record<string, string>> {
  if (!values || values.length === 0) {
    return {}
  }

  const parsed: Record<string, string> = {}
  for (const value of values) {
    const index = value.indexOf('=')
    if (index <= 0) {
      throw new ConfigError(`Invalid --conf entry "${value}". Expected key=value.`)
    }

    const key = value.slice(0, index).trim()
    const parsedValue = value.slice(index + 1)
    if (!key) {
      throw new ConfigError(`Invalid --conf entry "${value}". Key cannot be empty.`)
    }

    parsed[key] = parsedValue
  }

  return parsed
}

export function mergeStringArrays(
  ...arrays: ReadonlyArray<readonly string[] | undefined>
): readonly string[] {
  const merged = new Set<string>()
  for (const arr of arrays) {
    for (const value of arr ?? []) {
      merged.add(value)
    }
  }

  return [...merged]
}

export function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function toMilliseconds(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : seconds * 1000
}

