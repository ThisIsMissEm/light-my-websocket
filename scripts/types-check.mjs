// Run @arethetypeswrong/cli against the would-be-published tarball.
//
// attw's `--pack .` flag is hardcoded to call `npm pack`. We pack with
// pnpm instead and pass the resulting tarball to attw directly, so the
// check is runnable in environments where `npm` is unavailable or not
// the canonical package manager.
//
// Wrapping in Node (rather than an inline shell one-liner) keeps the
// flow cross-platform; the workflow matrix runs on Windows too.

import { execFileSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'

const packJson = execFileSync('pnpm', ['pack', '--json'], { encoding: 'utf8' })
const { filename } = JSON.parse(packJson)

try {
  execFileSync(
    'pnpm',
    [
      'exec',
      'attw',
      `./${filename}`,
      '--profile',
      'esm-only',
      '--profile',
      'node16',
      '--ignore-rules',
      'cjs-resolves-to-esm',
    ],
    { stdio: 'inherit' }
  )
} finally {
  try {
    unlinkSync(`./${filename}`)
  } catch {
    // tarball may not exist if pack failed; ignore
  }
}
