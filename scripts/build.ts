// Builds the Vercel deployment by hand, using the Build Output API:
// https://vercel.com/docs/build-output-api
//
// Vercel's own builder for `api/` is not configurable and refuses to rewrite
// `.ts` extensions, so instead of fighting it we produce `.vercel/output`
// ourselves and it gets deployed as-is.
//
// Layout we generate:
//   .vercel/output/config.json                          routing
//   .vercel/output/static/index.html                    the landing page
//   .vercel/output/functions/api/webhook.func/          -> /api/webhook
//     index.js          bundled handler (exports POST)
//     package.json      marks the bundle as ESM
//     node_modules/     only what the bundle actually imports
//     .vc-config.json   lambda settings

import fs from 'node:fs'
import path from 'node:path'
import { rollup } from 'rollup'
import resolve from '@rollup/plugin-node-resolve'
import esbuild from 'rollup-plugin-esbuild'
import { nodeFileTrace } from '@vercel/nft'

const root = path.join(import.meta.dirname, '..')
const outDir = path.join(root, '.vercel', 'output')
const staticDir = path.join(outDir, 'static')
const funcDir = path.join(outDir, 'functions', 'api', 'webhook.func')
const handler = 'index.js'

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(funcDir, { recursive: true })
fs.mkdirSync(staticDir, { recursive: true })

/// Handler bundle

console.log('Bundling handler')

const build = await rollup({
  input: path.join(root, 'src', 'webhook.ts'),
  plugins: [
    // @ts-ignore
    resolve(),
    esbuild({ include: /\.ts$/, sourceMap: true }),
  ],
  // Dependencies stay external and are copied in below. Bundling them is not
  // an option anyway: some are CommonJS, some (sharp) are native.
  external: id => /node_modules/.test(id),
})
await build.write({
  sourcemap: 'inline',
  file: path.join(funcDir, handler),
  format: 'esm',
  exports: 'named',
})
await build.close()

// The bundle is ESM, but the lambda has no package.json above it to say so.
fs.writeFileSync(
  path.join(funcDir, 'package.json'),
  JSON.stringify({ type: 'module' }, null, 4),
)

/// Dependencies
//
// Node resolves the bundle's bare imports from `<funcDir>/node_modules`, so
// trace what it actually reaches and copy just that. Tracing runs against the
// repo root (where `node_modules` lives) and gives us root-relative paths.

console.log('Tracing dependencies')

const traced = await nodeFileTrace([path.join(funcDir, handler)], {
  base: root,
  processCwd: root,
})
for(const warning of traced.warnings) {
  // sharp lists a prebuilt binary for every platform it supports, and only the
  // one for this platform is installed. The rest are expected to be missing.
  if(/@img\/sharp-/.test(warning.message)) continue
  console.warn('Trace warning: ' + warning.message)
}

let copied = 0
for(const file of traced.fileList) {
  // The entry itself is inside the output directory and already in place.
  if(!file.startsWith('node_modules/')) continue

  const from = path.join(root, file)
  const to = path.join(funcDir, file)

  fs.mkdirSync(path.dirname(to), { recursive: true })

  // pnpm's node_modules is a forest of symlinks into `.pnpm`. Keep them as
  // symlinks: the targets are traced too, so they land in the output as well.
  const stat = fs.lstatSync(from)
  if(stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(from), to)
  }
  else if(stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true })
  }
  else {
    fs.copyFileSync(from, to)
  }
  copied++
}
console.log('Copied ' + copied + ' dependency files')

fs.writeFileSync(path.join(funcDir, '.vc-config.json'), JSON.stringify({
  handler,
  runtime: 'nodejs24.x',
  launcherType: 'Nodejs',
  shouldAddHelpers: true,
  shouldAddSourcemapSupport: true,
  supportsResponseStreaming: true,
  maxDuration: 300,
}, null, 4))

/// Landing page

fs.writeFileSync(
  path.join(staticDir, 'index.html'),
  'balbes bot. That\'s it (what did you expect?, it\'s a telegram bot)\n',
)

/// Routing

fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    // `/api/webhook` and `/index.html` are both served from here.
    { handle: 'filesystem' },
    { src: '/.*', dest: '/index.html' },
  ],
}, null, 4))

console.log('done')
