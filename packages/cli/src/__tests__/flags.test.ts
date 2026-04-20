import {ConfigError} from '../lib/config'
import {mergeStringArrays, parseConfEntries} from '../lib/flags'

describe('flag helpers', () => {
  test('parseConfEntries parses key value pairs', () => {
    const parsed = parseConfEntries(['spark.a=1', 'spark.b=foo=bar'])
    expect(parsed).toEqual({
      'spark.a': '1',
      'spark.b': 'foo=bar',
    })
  })

  test('parseConfEntries rejects invalid input', () => {
    expect(() => parseConfEntries(['missing-separator'])).toThrow(ConfigError)
    expect(() => parseConfEntries(['=empty-key'])).toThrow(ConfigError)
  })

  test('mergeStringArrays deduplicates while preserving order', () => {
    const merged = mergeStringArrays(['a', 'b'], ['b', 'c'])
    expect(merged).toEqual(['a', 'b', 'c'])
  })
})

