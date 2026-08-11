#!/usr/bin/env node
// Production-dependency audit gate.
// Fails on any high/critical advisory EXCEPT ones explicitly allow-listed below,
// which have no upstream fix and are not reachable in our usage.
import { spawnSync } from 'node:child_process'

// image-size (pulled in transitively by pptxgenjs for image dimension parsing) has
// two high DoS advisories with NO patched version available (affected <= 2.0.2, the
// latest). We only generate PPTX from trusted internal data and never parse
// attacker-supplied images, so the infinite-loop DoS is not reachable. Revisit when
// image-size ships a fix or pptxgenjs drops the dependency.
const ALLOWED_ADVISORIES = new Set(['GHSA-w3rx-r6r6-pgpr', 'GHSA-5p2g-fcmc-qvqq'])
const ALLOWED_VIA_PACKAGES = new Set(['image-size'])
const BLOCKING_SEVERITIES = new Set(['high', 'critical'])

const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
})

if (!result.stdout) {
  console.error('audit-check: npm audit produced no output')
  console.error(result.stderr || '')
  process.exit(1)
}

let report
try {
  report = JSON.parse(result.stdout)
} catch {
  console.error('audit-check: could not parse npm audit JSON output')
  process.exit(1)
}

const ghsaFrom = (url) => (typeof url === 'string' ? (url.match(/GHSA-[\w-]+/)?.[0] ?? null) : null)

const blocking = []
for (const [name, info] of Object.entries(report.vulnerabilities ?? {})) {
  if (!BLOCKING_SEVERITIES.has(info.severity)) continue
  const via = Array.isArray(info.via) ? info.via : []
  const allAllowed = via.every((entry) => {
    if (typeof entry === 'string') return ALLOWED_VIA_PACKAGES.has(entry)
    const ghsa = ghsaFrom(entry.url)
    return ghsa !== null && ALLOWED_ADVISORIES.has(ghsa)
  })
  if (!allAllowed) {
    blocking.push({ name, severity: info.severity, via: via.map((e) => (typeof e === 'string' ? e : ghsaFrom(e.url) ?? e.title)) })
  }
}

const allowed = Object.entries(report.vulnerabilities ?? {})
  .filter(([, info]) => BLOCKING_SEVERITIES.has(info.severity))
  .map(([name, info]) => `${name} (${info.severity})`)
  .filter((entry) => !blocking.some((b) => entry.startsWith(b.name)))

if (allowed.length) {
  console.log('audit-check: allow-listed high/critical advisories (no upstream fix, not reachable):')
  for (const entry of allowed) console.log(`  - ${entry}`)
}

if (blocking.length) {
  console.error('audit-check: blocking high/critical vulnerabilities found:')
  for (const b of blocking) console.error(`  - ${b.name} (${b.severity}) via ${b.via.join(', ')}`)
  console.error('\nRun "npm audit --omit=dev" for details. Fix by upgrading, or add a documented allow-list entry only if there is no fix and it is not reachable.')
  process.exit(1)
}

console.log('audit-check: no blocking high/critical vulnerabilities.')
process.exit(0)
