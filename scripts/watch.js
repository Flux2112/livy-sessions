#!/usr/bin/env node

const {spawn} = require('node:child_process')

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const watchTargets = ['@livy/core', '@livy/extension', '@livy/cli']

const children = watchTargets.map((workspace) => {
  const child = spawn(npmCommand, ['run', 'watch', '-w', workspace], {
    stdio: 'inherit',
    shell: false,
  })

  child.on('exit', (code, signal) => {
    if (signal !== null) {
      process.exit(1)
      return
    }

    if (code !== 0) {
      shutdown()
      process.exit(code ?? 1)
    }
  })

  return child
})

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGINT')
    }
  }
}

process.on('SIGINT', () => {
  shutdown()
  process.exit(130)
})

process.on('SIGTERM', () => {
  shutdown()
  process.exit(143)
})