// Vercel checks server functions before building.
// But then still runs the build before it actually needs them.
// But then runs its own build for serverless functions that is not configurable.
// But then it doesn't rewrite file extensions, so doesn't actually build.
// Cool.
// This is a hack. I output the built bundle so that the useless tool can
// use that instead of desecrating my code.
// The best part is they could've just not checked for this file
// before starting the build and nothing would've changed.
export * from '../why-is-vercel-so-bad-why-can-i-not-do-custom-build-of-server-functions-why-does-vercel-node-package-not-rewrite-ts-extension.js'
