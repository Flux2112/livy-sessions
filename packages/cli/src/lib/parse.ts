import {ConfigError} from './config'

export function parseId(label: string, value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new ConfigError(`Invalid ${label}: ${value}`)
  }

  return parsed
}

export function normalizeUser(value: string | null): string {
  return (value ?? '').trim().toLowerCase()
}

