import fs from 'node:fs'
import path from 'node:path'
import { rollup } from 'rollup'
import resolve from '@rollup/plugin-node-resolve';
import esbuild from 'rollup-plugin-esbuild'
//import commonjs from '@rollup/plugin-commonjs';

const root = path.join(import.meta.dirname, '..')

const build = await rollup({
  input: path.join(root, 'src', 'webhook.ts'),
  plugins: [
    // @ts-ignore
    resolve(),
    esbuild({ include: /\.ts$/, sourceMap: true }),
    //commonjs()
  ],
  external: id => /node_modules/.test(id),
})
await build.write({
  sourcemap: 'inline',
  file: path.join(root, 'why-is-vercel-so-bad-why-can-i-not-do-custom-build-of-server-functions-why-does-vercel-node-package-not-rewrite-ts-extension.js'),
  format: 'esm',
  exports: 'named'
})
await build.close()

try {
  fs.mkdirSync(path.join(root, 'public'))
  fs.writeFileSync(path.join(root, 'public', 'index.html'), 'balbes bot. That\'s it (what did you expect?, it\'s a telegram bot)')
} catch(error) {}
