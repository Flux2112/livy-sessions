export interface LogWriter {
  log(message?: string): void
}

export function writeResult<T>(
  writer: LogWriter,
  value: T,
  options: {
    readonly pretty: boolean
    readonly renderPretty?: (input: T) => string
  }
): void {
  if (options.pretty && options.renderPretty) {
    writer.log(options.renderPretty(value))
    return
  }

  writer.log(JSON.stringify(value, null, 2))
}

export function formatKeyValueCard(rows: ReadonlyArray<readonly [string, unknown]>): string {
  if (rows.length === 0) {
    return '(empty)'
  }

  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0)
  return rows
    .map(([key, value]) => `${key.padEnd(width)} : ${formatScalar(value)}`)
    .join('\n')
}

export function formatTable(headers: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  const allRows: string[][] = [headers.map((header) => header.trim())]
  for (const row of rows) {
    allRows.push(row.map((value) => formatScalar(value)))
  }

  const widths = headers.map((_, column) => allRows.reduce((max, row) => Math.max(max, row[column].length), 0))
  const separator = widths.map((width) => '-'.repeat(width)).join('-+-')
  const renderedRows = allRows.map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join(' | '))

  return [renderedRows[0], separator, ...renderedRows.slice(1)].join('\n')
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

