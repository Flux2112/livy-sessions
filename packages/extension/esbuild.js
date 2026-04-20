// @ts-check
const esbuild = require('esbuild')

const watch = process.argv.includes('--watch')
const minify = process.argv.includes('--minify')

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode', 'kerberos'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  minify,
  sourcemap: !minify,
  logLevel: 'info',
}

if (watch) {
  esbuild.context(buildOptions).then(ctx => {
    ctx.watch()
    console.log('Watching for changes...')
  })
} else {
  esbuild.build(buildOptions).catch(() => process.exit(1))
}
