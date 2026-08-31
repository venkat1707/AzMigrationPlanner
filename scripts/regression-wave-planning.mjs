// Ad-hoc regression harness for migration-wave-planning.ts. Loads several real dataset shapes
// (data/generated/**) and runs buildMigrationWavePlan across a matrix of option combinations,
// asserting structural invariants. Run with: node scripts/regression-wave-planning.mjs
// Requires `npm run build --workspace backend` to have produced services/backend/dist first.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { buildMigrationWavePlan, defaultMigrationWaveOptions } from '../services/backend/dist/migration-wave-planning.js'

const rootDir = path.dirname(fileURLToPath(import.meta.url)) + '/..'
const dataDir = path.join(rootDir, 'data', 'generated')

// --- minimal RFC 4180 CSV parser (handles quoted fields with embedded commas/newlines) ---
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += char
    } else if (char === '"') inQuotes = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\r') continue
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += char
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  const header = rows.shift()?.map((value) => value.trim()) ?? []
  return rows.filter((values) => values.length > 1 || values[0] !== '').map((values) => {
    const record = {}
    header.forEach((key, index) => { record[key] = values[index] ?? '' })
    return record
  })
}

function findDatasetFolders() {
  const folders = [dataDir]
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (entry.isDirectory()) folders.push(path.join(dataDir, entry.name))
  }
  return folders
}

function loadDataset(folder) {
  const files = fs.readdirSync(folder).filter((name) => fs.statSync(path.join(folder, name)).isFile())
  const assessmentFile = files.find((name) => /^ServerAssessment.*\.csv$/i.test(name))
  if (!assessmentFile) return null
  const infraFile = files.find((name) => /^CoreInfrastructure.*\.csv$/i.test(name))

  const assessmentRows = parseCsv(fs.readFileSync(path.join(folder, assessmentFile), 'utf8'))
  const assessments = assessmentRows.map((row) => ({
    serverName: row.SERVER_NAME,
    application: row.APPLICATION || null,
    environment: row.ENVIRONMENT_TYPE || null,
    migrationReadiness: row.MIGRATION_READINESS || null,
    securityReadiness: row.SECURITY_READINESS || null,
    storageGb: Number(row.ONPREM_STORAGE_GB || 0),
    databaseServer: false, // real classification runs post-import (refreshDatabaseServerFlags); not reproduced here
    totalIssues: Number(row.TOTAL_ISSUES_COUNT || 0),
    recommendedComputeSku: row.RECOMMENDED_COMPUTE_SKU || null,
    coHostedApplications: [],
  }))

  // A row with only a load_balancer_ip (no server_name/role/ip) registers a load-balancer VIP, not
  // a server - mirrors the hasServerValue check in core-infrastructure-import.ts.
  const infrastructureRows = infraFile
    ? parseCsv(fs.readFileSync(path.join(folder, infraFile), 'utf8'))
        .filter((row) => row.server_name || row.role || row.ip_address)
        .map((row) => ({ serverName: row.server_name, category: row.role }))
    : []

  const fingerprint = createHash('sha1')
    .update(fs.readFileSync(path.join(folder, assessmentFile)))
    .update(infraFile ? fs.readFileSync(path.join(folder, infraFile)) : '')
    .digest('hex')

  return { name: path.relative(dataDir, folder) || '(root)', assessments, infrastructureRows, fingerprint }
}

// Force manual-mode clustering to group each application's servers into one work unit (matches
// migration-wave-planning.test.ts convention: buildManualClusters only unions same-application
// servers when a dependency edge connects them), and inject a synthetic co-hosted application
// across two real applications in the same environment to exercise the merge/relocate path.
function buildSyntheticDependenciesAndCoHost(assessments) {
  const dependencies = []
  const byApplication = new Map()
  for (const server of assessments) {
    const key = `${server.application}\u0000${server.environment}`
    const list = byApplication.get(key) ?? []
    list.push(server)
    byApplication.set(key, list)
  }
  for (const servers of byApplication.values()) {
    for (let i = 1; i < servers.length; i++) {
      dependencies.push({ sourceServer: servers[i - 1].serverName, destinationServer: servers[i].serverName, connectionCount: 1 })
    }
  }

  // Pick two distinct applications sharing an environment and mark one server from each as
  // co-hosting a synthetic shared application, to trigger mergeCoHostedApplicationSprints.
  const byEnvironment = new Map()
  for (const server of assessments) {
    if (!server.application) continue
    const list = byEnvironment.get(server.environment) ?? new Map()
    if (!list.has(server.application)) list.set(server.application, server)
    byEnvironment.set(server.environment, list)
  }
  for (const apps of byEnvironment.values()) {
    if (apps.size < 2) continue
    const [first, second] = [...apps.values()]
    first.coHostedApplications = ['Synthetic Shared Service']
    second.coHostedApplications = ['Synthetic Shared Service']
    break
  }
  return dependencies
}

function normalize(value) { return String(value).trim().toLowerCase() }

function checkInvariants(dataset, options, plan) {
  const issues = []
  const { summary } = plan

  if (summary.excludedServers + summary.deferredServers + summary.plannedServers !== summary.assessedServers) {
    issues.push(`Server accounting mismatch: excluded(${summary.excludedServers}) + deferred(${summary.deferredServers}) + planned(${summary.plannedServers}) != assessed(${summary.assessedServers})`)
  }

  const allSprintServers = plan.waves.flatMap((wave) => wave.sprints).flatMap((sprint) => sprint.servers)
  if (allSprintServers.length !== summary.plannedServers) {
    issues.push(`Planned server count (${summary.plannedServers}) does not match servers actually placed in sprints (${allSprintServers.length})`)
  }
  const uniqueNames = new Set(allSprintServers.map((server) => normalize(server.name)))
  if (uniqueNames.size !== allSprintServers.length) {
    issues.push(`A server appears in more than one sprint (${allSprintServers.length} placements, ${uniqueNames.size} unique servers)`)
  }

  if (options.excludeCoreInfrastructure) {
    const infraInPlan = allSprintServers.filter((server) => server.infrastructureRoles?.length > 0)
    if (infraInPlan.length > 0) {
      issues.push(`excludeCoreInfrastructure was set but ${infraInPlan.length} core-infrastructure server(s) still appear in the plan (e.g. ${infraInPlan[0].name})`)
    }
    const wrongReason = plan.excluded.filter((server) => server.infrastructureRoles?.length > 0 && server.reason !== 'Server is core infrastructure, excluded from this plan.')
    if (wrongReason.length > 0) {
      issues.push(`${wrongReason.length} excluded core-infrastructure server(s) have an unexpected exclusion reason (e.g. "${wrongReason[0].reason}" for ${wrongReason[0].name})`)
    }
  } else {
    const missingInfra = new Set(dataset.infrastructureRows.map((row) => normalize(row.serverName)))
    for (const server of allSprintServers) if (server.infrastructureRoles?.length > 0) missingInfra.delete(normalize(server.name))
    // Servers can legitimately be missing from the plan for other reasons (deferred/other exclusion), so only
    // flag if they vanished entirely (not in plan, not deferred, not excluded).
    const accountedFor = new Set([
      ...allSprintServers.map((server) => normalize(server.name)),
      ...plan.deferred.map((server) => normalize(server.name)),
      ...plan.excluded.map((server) => normalize(server.name)),
    ])
    for (const name of missingInfra) if (!accountedFor.has(name)) issues.push(`Core infrastructure server "${name}" is missing from plan entirely (not planned, deferred, or excluded)`)
  }

  // No application's servers should be split across sprints within the same environment (both
  // modes here always receive same-application dependency edges, forcing that clustering) - EXCEPT
  // that core-infrastructure-flagged servers are intentionally pulled into a separate infrastructure
  // pool by design (see the autoClusterPools comment in migration-wave-planning.ts), so a server that
  // nominally belongs to an application but is also flagged as core infrastructure is excluded here.
  if (options.considerEnvironments) {
    const sprintsByAppEnv = new Map()
    for (const wave of plan.waves) {
      for (const sprint of wave.sprints) {
        for (const server of sprint.servers) {
          if (server.infrastructureRoles?.length > 0) continue
          const key = `${server.application}\u0000${server.environment}`
          const set = sprintsByAppEnv.get(key) ?? new Set()
          set.add(sprint.sequence)
          sprintsByAppEnv.set(key, set)
        }
      }
    }
    for (const [key, sprintSet] of sprintsByAppEnv) {
      if (sprintSet.size > 1) {
        const [application, environment] = key.split('\u0000')
        issues.push(`Application "${application}" (${environment}) has servers split across ${sprintSet.size} different sprints: ${[...sprintSet].join(', ')}`)
      }
    }
  }

  // Any sprint larger than the manual-mode maximum must explain why (an exception message).
  if (!options.autoSizeSprints) {
    for (const wave of plan.waves) {
      for (const sprint of wave.sprints) {
        if (sprint.serverCount > options.maximumServers && sprint.exceptions.length === 0) {
          issues.push(`Sprint ${sprint.sequence} has ${sprint.serverCount} servers (over the ${options.maximumServers}-server maximum) with no exception explaining why`)
        }
      }
    }
  }

  return issues
}

function run() {
  const optionMatrix = []
  for (const autoSizeSprints of [false, true]) {
    for (const excludeCoreInfrastructure of [false, true]) {
      for (const separateDataHeavyWorkloads of [false, true]) {
        optionMatrix.push({ autoSizeSprints, excludeCoreInfrastructure, separateDataHeavyWorkloads })
      }
    }
  }

  const seenHashes = new Set()
  const allIssues = []
  let runCount = 0

  for (const folder of findDatasetFolders()) {
    const dataset = loadDataset(folder)
    if (!dataset) continue
    if (seenHashes.has(dataset.fingerprint)) continue // skip byte-identical duplicate dataset folders
    seenHashes.add(dataset.fingerprint)

    const dependencies = buildSyntheticDependenciesAndCoHost(dataset.assessments)

    for (const optionOverrides of optionMatrix) {
      runCount++
      const options = { ...defaultMigrationWaveOptions, minimumServers: 5, maximumServers: 20, ...optionOverrides }
      let plan
      try {
        plan = buildMigrationWavePlan(dataset.assessments, dataset.infrastructureRows, dependencies, options)
      } catch (error) {
        allIssues.push({ dataset: dataset.name, options: optionOverrides, issue: `Threw an exception: ${error.stack ?? error}` })
        continue
      }
      const issues = checkInvariants(dataset, options, plan)
      for (const issue of issues) allIssues.push({ dataset: dataset.name, options: optionOverrides, issue })
    }
  }

  console.log(`Ran ${runCount} dataset x option combinations across ${seenHashes.size} distinct datasets.\n`)
  if (allIssues.length === 0) {
    console.log('No invariant violations found.')
  } else {
    console.log(`Found ${allIssues.length} issue(s):\n`)
    for (const { dataset, options, issue } of allIssues) {
      console.log(`- [${dataset} | ${JSON.stringify(options)}] ${issue}`)
    }
  }
  process.exitCode = allIssues.length > 0 ? 1 : 0
}

run()
