import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { resolve } from 'node:path'

const assessmentHeaders = [
  'APPLICATION', 'SERVER_NAME', 'MIGRATION_READINESS', 'SECURITY_READINESS', 'OS_SUPPORT_STATUS',
  'SUPPORT_ENDS_IN_MONTHS', 'SUPPORT_END_DATE', 'RECOMMENDED_STORAGE_SKU', 'RECOMMENDED_STORAGE_SIZE_GB',
  'RECOMMENDED_NUMBER_OF_CORES', 'STORAGE_UTILIZATION_PERCENT', 'RECOMMENDED_COMPUTE_SKU',
  'TOTAL_MONTHLY_COST_USD', 'MONTHLY_COMPUTE_COST_USD', 'MONTHLY_STORAGE_COST_USD',
  'MONTHLY_SECURITY_COST_USD', 'CONFIDENCE_RATING_PERCENT', 'OPERATING_SYSTEM_NAME', 'OS_VERSION',
  'OS_ARCHITECTURE', 'BOOT_TYPE', 'TOTAL_DISKS_COUNT', 'ONPREM_STORAGE_GB', 'ONPREM_CPU_USAGE_PERCENT',
  'ONPREM_MEMORY_USAGE_PERCENT', 'DISK_READ_IOPS', 'DISK_WRITE_IOPS', 'NETWORK_READ_MBPS',
  'NETWORK_WRITE_MBPS', 'DISK_READ_MBPS', 'DISK_WRITE_MBPS', 'ONPREM_CORES_COUNT', 'ONPREM_MEMORY_MB',
  'NETWORK_ADAPTERS_COUNT', 'SOURCE_SYSTEM', 'IP_ADDRESS', 'MAC_ADDRESS', 'TOTAL_ISSUES_COUNT',
  'RESOURCE_TAGS', 'CARBON_EMISSIONS_SCOPE1_MtCO2e', 'CARBON_EMISSIONS_SCOPE2_MtCO2e',
  'CARBON_EMISSIONS_SCOPE3_MtCO2e', 'TOTAL_CARBON_EMISSIONS_MtCO2e', 'ENVIRONMENT_TYPE',
]

const dependencyHeaders = [
  'Date', 'Source Appliance Name', 'Source Machine ARM ID', 'Source Server Name', 'Source IP',
  'Source Application', 'Source Process', 'Destination Machine ARM ID', 'Destination Server Name',
  'Destination IP', 'Destination Application', 'Destination Process', 'Destination Port', 'Connection Count',
]

const applicationNames = [
  'Customer Identity Portal', 'Digital Banking Hub', 'Payments Gateway', 'Loan Origination',
  'Mortgage Servicing', 'Credit Decision Engine', 'Fraud Detection Platform', 'Treasury Operations',
  'Trade Settlement', 'Wealth Portfolio Manager', 'Insurance Policy Admin', 'Claims Processing',
  'Customer Relationship Management', 'Contact Center Desktop', 'Branch Operations', 'ATM Management',
  'Mobile Banking API', 'Open Banking Gateway', 'Merchant Acquiring', 'Card Authorization',
  'Card Statement Service', 'Billing and Invoicing', 'Accounts Receivable', 'Accounts Payable',
  'General Ledger', 'Financial Consolidation', 'Tax Reporting', 'Regulatory Reporting',
  'Risk Analytics', 'Liquidity Risk', 'Market Risk', 'Credit Risk', 'Enterprise Data Warehouse',
  'Customer Data Platform', 'Master Data Management', 'Reference Data Service', 'Data Quality Hub',
  'Analytics Workbench', 'Executive Insights', 'Sales Performance', 'Revenue Forecasting',
  'Order Management', 'Inventory Control', 'Warehouse Management', 'Transportation Planning',
  'Supplier Portal', 'Procurement Hub', 'Product Catalog', 'Pricing Engine', 'Promotion Management',
  'Ecommerce Storefront', 'Retail Point of Sale', 'Store Operations', 'Loyalty Rewards',
  'Human Resources Portal', 'Payroll Processing', 'Talent Management', 'Learning Management',
  'Workforce Scheduling', 'Time and Attendance', 'Employee Benefits', 'Expense Management',
  'Travel Management', 'Legal Case Management', 'Contract Lifecycle', 'Records Management',
  'Document Collaboration', 'Knowledge Center', 'Corporate Intranet', 'Service Desk',
  'Asset Management', 'Change Management', 'Release Orchestration', 'API Management',
  'Integration Services', 'Event Streaming Hub', 'Notification Service', 'Email Relay',
  'Enterprise Search', 'Content Publishing', 'Video Collaboration', 'Facilities Management',
  'Physical Access Control', 'Security Operations', 'Vulnerability Management', 'Audit Management',
  'Compliance Monitoring', 'Business Continuity', 'Disaster Recovery Portal', 'Backup Reporting',
  'Network Operations', 'Capacity Planning', 'Cloud Governance', 'Cost Management',
  'Customer Communications', 'Enterprise Scheduling',
]

const environments = [
  { name: 'Dev', code: 'DEV', secondOctet: 20 },
  { name: 'Test', code: 'TST', secondOctet: 30 },
  { name: 'Pre-prod', code: 'PPD', secondOctet: 40 },
  { name: 'Prod', code: 'PRD', secondOctet: 50 },
]

const roleSpecs = [
  { role: 'Active Directory / DNS', code: 'DC', count: 3, cores: 8, memory: 32768, storage: 512 },
  { role: 'Proxy', code: 'PXY', count: 4, cores: 4, memory: 16384, storage: 128 },
  { role: 'Print', code: 'PRT', count: 6, cores: 4, memory: 16384, storage: 512 },
  { role: 'Windows File', code: 'FIL', count: 26, cores: 8, memory: 32768, storage: 4096 },
  { role: 'Backup', code: 'BAK', count: 12, cores: 16, memory: 65536, storage: 8192 },
  { role: 'Monitoring', code: 'MON', count: 8, cores: 8, memory: 32768, storage: 1024 },
  { role: 'Management', code: 'MGT', count: 21, cores: 8, memory: 32768, storage: 512 },
  { role: 'Config Manager', code: 'CFG', count: 6, cores: 8, memory: 32768, storage: 1024 },
  { role: 'Web', code: 'WEB', count: 32, cores: 4, memory: 16384, storage: 256 },
  { role: 'Application', code: 'APP', count: 352, cores: 8, memory: 32768, storage: 512 },
  { role: 'SQL Server', code: 'SQL', count: 40, cores: 16, memory: 65536, storage: 2048 },
  { role: 'Oracle Database', code: 'ORA', count: 50, cores: 16, memory: 65536, storage: 2048 },
  { role: 'MySQL Database', code: 'MYQ', count: 10, cores: 8, memory: 32768, storage: 1024 },
  { role: 'PostgreSQL Database', code: 'PGQ', count: 6, cores: 8, memory: 32768, storage: 1024 },
  { role: 'Report', code: 'RPT', count: 48, cores: 8, memory: 32768, storage: 1024 },
]

const infrastructureCodes = new Set(['DC', 'PXY', 'PRT', 'FIL', 'BAK', 'MON', 'MGT', 'CFG'])
const databaseCodes = new Set(['SQL', 'ORA', 'MYQ', 'PGQ'])
const sensitiveApplicationCount = 12
const defaultDependencyCount = 2_000_000
const defaultRowsPerFile = 500_000

function parseArguments() {
  const values = Object.fromEntries(process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=', 2)
    return [key, value]
  }))
  return {
    outputDirectory: resolve(values['output-dir'] ?? 'data/generated'),
    dependencyCount: Number(values['dependency-count'] ?? defaultDependencyCount),
    rowsPerFile: Number(values['rows-per-file'] ?? defaultRowsPerFile),
  }
}

function csvValue(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function csvRow(values) {
  return `${values.map(csvValue).join(',')}\n`
}

async function writeChunk(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain')
}

async function closeStream(stream) {
  stream.end()
  await once(stream, 'close')
}

function applicationCode(name, index) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean)
  const root = words.length === 1 ? words[0].slice(0, 6) : words.map((word) => word.slice(0, 3)).join('').slice(0, 6)
  return `${root}${String(index + 1).padStart(2, '0')}`
}

function buildApplications() {
  return applicationNames.map((name, index) => ({
    id: index + 1,
    name,
    code: applicationCode(name, index),
    sensitive: index < sensitiveApplicationCount,
    hasPreProd: index % 3 !== 2,
    hasReporting: index % 2 === 0,
    businessOwner: ['Customer Platforms', 'Finance', 'Operations', 'Data and Analytics', 'Corporate Services'][index % 5],
  }))
}

function buildDeployments(applications) {
  const deployments = []
  for (const application of applications) {
    for (const environment of environments) {
      if (environment.name === 'Pre-prod' && !application.hasPreProd) continue
      deployments.push({ application, environment, servers: { WEB: [], APP: [], DB: [], RPT: [] } })
    }
  }
  return deployments
}

function assignmentOrder(deployments, reportOnly = false) {
  const eligible = reportOnly ? deployments.filter(({ application }) => application.hasReporting) : deployments
  const sensitive = eligible.filter(({ application }) => application.sensitive)
  return [...sensitive, ...eligible.filter(({ application }) => !application.sensitive)]
}

function deploymentAssignments(deployments, count, reportOnly = false, offset = 0) {
  const order = assignmentOrder(deployments, reportOnly)
  return Array.from({ length: count }, (_, index) => order[(index + offset) % order.length])
}

function environmentForInfrastructure(index, code) {
  if (['DC', 'PXY', 'PRT', 'FIL', 'BAK'].includes(code)) return environments[3]
  return environments[(index + 3) % environments.length]
}

function serverIp(environment, roleCode, sequence, isolated) {
  const roleIndex = roleSpecs.findIndex(({ code }) => code === roleCode) + 1
  const secondOctet = isolated ? 90 + (environment.secondOctet / 10 - 2) : environment.secondOctet
  const thirdOctet = roleIndex * 10 + Math.floor((sequence - 1) / 240)
  const fourthOctet = ((sequence - 1) % 240) + 10
  return `10.${secondOctet}.${thirdOctet}.${fourthOctet}`
}

function sizedResources(spec, environment, isInfrastructure) {
  const multiplier = isInfrastructure ? 1 : environment.name === 'Dev' ? 0.5 : environment.name === 'Test' ? 0.75 : 1
  return {
    cores: Math.max(2, Math.ceil(spec.cores * multiplier / 2) * 2),
    memory: Math.max(8192, Math.ceil(spec.memory * multiplier / 8192) * 8192),
    storage: Math.max(128, Math.ceil(spec.storage * multiplier / 128) * 128),
  }
}

function macAddress(id) {
  const bytes = [0x02, 0x4d, 0x46, (id >> 16) & 255, (id >> 8) & 255, id & 255]
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(':').toUpperCase()
}

function assignOperatingSystems(servers) {
  const windowsOnlyRoles = new Set(['DC', 'PRT', 'FIL', 'CFG', 'SQL', 'RPT'])
  const linuxPriority = ['ORA', 'MYQ', 'PGQ', 'WEB', 'APP', 'PXY', 'BAK', 'MON', 'MGT']
  const linuxServers = servers
    .filter(({ roleCode }) => !windowsOnlyRoles.has(roleCode))
    .sort((left, right) => linuxPriority.indexOf(left.roleCode) - linuxPriority.indexOf(right.roleCode) || left.id - right.id)
    .slice(0, 200)
  const linuxIds = new Set(linuxServers.map(({ id }) => id))
  const windowsServers = servers.filter(({ id }) => !linuxIds.has(id))
  const orderedWindows = [...windowsServers.filter(({ roleCode }) => !infrastructureCodes.has(roleCode)), ...windowsServers.filter(({ roleCode }) => infrastructureCodes.has(roleCode))]
  const orderedLinux = [...linuxServers.filter(({ roleCode }) => !infrastructureCodes.has(roleCode)), ...linuxServers.filter(({ roleCode }) => infrastructureCodes.has(roleCode))]
  const windowsVersions = [
    ...Array(8).fill('2012'), ...Array(8).fill('2012 R2'), ...Array(88).fill('2016'),
    ...Array(120).fill('2019'), ...Array(120).fill('2022'), ...Array(80).fill('2025'),
  ]
  const linuxVersions = [
    ...Array(35).fill(['RHEL', '7.9']), ...Array(55).fill(['RHEL', '8.10']), ...Array(50).fill(['RHEL', '9.5']),
    ...Array(20).fill(['SLES', '14']), ...Array(25).fill(['SLES', '15']), ...Array(15).fill(['SLES', '16']),
  ]
  orderedWindows.forEach((server, index) => {
    const version = windowsVersions[index]
    server.osFamily = 'Windows'
    server.osDistribution = 'Windows Server'
    server.osVersion = version
    server.osName = `Windows Server ${version} Datacenter`
  })
  orderedLinux.forEach((server, index) => {
    const [distribution, version] = linuxVersions[index]
    server.osFamily = 'Linux'
    server.osDistribution = distribution
    server.osVersion = version
    server.osName = distribution === 'RHEL' ? 'Red Hat Enterprise Linux' : 'SUSE Linux Enterprise Server'
  })
}

function buildServers(applications, deployments) {
  const servers = []
  let id = 1
  let databaseAssignmentOffset = 0
  for (const spec of roleSpecs) {
    const isInfrastructure = infrastructureCodes.has(spec.code)
    const isDatabase = databaseCodes.has(spec.code)
    const assignments = isInfrastructure
      ? []
      : deploymentAssignments(deployments, spec.count, spec.code === 'RPT', isDatabase ? databaseAssignmentOffset : 0)
    if (isDatabase) databaseAssignmentOffset += spec.count
    for (let index = 0; index < spec.count; index++) {
      let deployment = assignments[index]
      let environment = deployment?.environment ?? environmentForInfrastructure(index, spec.code)
      let application = deployment?.application
      if (spec.code === 'MGT' && index < sensitiveApplicationCount) {
        application = applications[index]
        environment = environments[3]
      }
      const isolated = Boolean(application?.sensitive && (!isInfrastructure || spec.code === 'MGT'))
      const ownerCode = application?.code ?? 'CORP'
      const name = `${ownerCode}-${environment.code}-${spec.code}-${String(index + 1).padStart(3, '0')}`
      const resources = sizedResources(spec, environment, isInfrastructure)
      const server = {
        id, name, ip: serverIp(environment, spec.code, index + 1, isolated), role: spec.role,
        roleCode: spec.code, environment: environment.name, environmentCode: environment.code,
        application: application?.name ?? `Core Infrastructure - ${spec.role}`,
        applicationCode: application?.code ?? 'CORP', sensitive: isolated, isolated,
        cores: resources.cores, memory: resources.memory, storage: resources.storage,
        armId: `/subscriptions/synthetic/resourceGroups/onprem-${environment.code.toLowerCase()}/providers/Microsoft.HybridCompute/machines/${name}`,
      }
      servers.push(server)
      if (deployment) {
        const tier = databaseCodes.has(spec.code) ? 'DB' : spec.code
        deployment.servers[tier].push(server)
      }
      id++
    }
  }
  assignOperatingSystems(servers)
  return servers
}

function roleProcess(server, destination = false) {
  if (server.osFamily === 'Linux') {
    const linuxProcesses = {
      LB: 'haproxy', PXY: 'squid', BAK: 'backup-agent', MON: 'monitor-agent', MGT: 'sshd', WEB: 'nginx', APP: 'java',
      ORA: 'oracle', MYQ: 'mysqld', PGQ: 'postgres',
    }
    if (linuxProcesses[server.roleCode]) return linuxProcesses[server.roleCode]
  }
  const processes = {
    LB: 'haproxy', DC: destination ? 'dns.exe' : 'lsass.exe', PXY: 'squid.exe', PRT: 'spoolsv.exe', FIL: 'System',
    BAK: 'backup-agent.exe', MON: 'monitor-agent.exe', MGT: 'winrm.exe', CFG: 'ccmexec.exe',
    WEB: 'haproxy.exe', APP: 'dotnet.exe', SQL: 'sqlservr.exe', ORA: 'oracle.exe',
    MYQ: 'mysqld.exe', PGQ: 'postgres.exe', RPT: 'reportserver.exe',
  }
  return processes[server.roleCode]
}

function destinationPort(server, variant = 0) {
  const ports = {
    DC: variant % 2 ? 53 : 636, PXY: 3128, PRT: 9100, FIL: 445, BAK: 10000, MON: 5666,
    MGT: 5985, CFG: 10123, WEB: 443, APP: variant % 2 ? 8080 : 8443, SQL: 1433,
    ORA: 1521, MYQ: 3306, PGQ: 5432, RPT: 443,
  }
  return ports[server.roleCode]
}

function pick(values, seed) {
  return values[Math.abs(seed) % values.length]
}

function serverPool(servers, environment, tier, isolated) {
  return servers.filter((server) => server.environment === environment && server.isolated === isolated && (
    tier === 'DB' ? databaseCodes.has(server.roleCode) : server.roleCode === tier
  ))
}

function deploymentServer(deployment, servers, tier, offset = 0) {
  const owned = deployment.servers[tier]
  if (owned.length) return pick(owned, offset)
  const pool = serverPool(servers, deployment.environment.name, tier, deployment.application.sensitive)
  if (!pool.length) throw new Error(`No ${tier} server for ${deployment.application.name} ${deployment.environment.name}`)
  return pick(pool, deployment.application.id + offset)
}

function databaseServerForDeployment(deployment, servers) {
  const { application, environment } = deployment
  if (!application.sensitive && application.id > sensitiveApplicationCount && application.id % 3 !== 2) {
    const pool = serverPool(servers, environment.name, 'DB', false)
    const sharedPool = pool.slice(0, Math.min(8, pool.length))
    if (sharedPool.length) {
      const cohort = Math.floor((application.id - sensitiveApplicationCount - 1) / 6)
      return sharedPool[cohort % sharedPool.length]
    }
  }
  return deploymentServer(deployment, servers, 'DB')
}

function buildLoadBalancers() {
  return environments.flatMap((environment) => [false, true].map((isolated) => {
    const secondOctet = isolated ? 90 + (environment.secondOctet / 10 - 2) : environment.secondOctet
    const zone = isolated ? 'ISO' : 'CORP'
    const name = `${zone}-${environment.code}-LB-01`
    return {
      id: 10_000 + environment.secondOctet + Number(isolated), name, ip: `10.${secondOctet}.5.5`, role: 'Load Balancer',
      roleCode: 'LB', environment: environment.name, environmentCode: environment.code,
      application: 'Shared Load Balancer', applicationCode: zone, isolated,
      armId: `/subscriptions/synthetic/resourceGroups/network-${environment.code.toLowerCase()}/providers/Microsoft.Network/loadBalancers/${name}`,
      osFamily: 'Linux',
    }
  }))
}

function loadBalancerForDeployment(deployment, loadBalancers) {
  return loadBalancers.find(({ environment, isolated }) => (
    environment === deployment.environment.name && isolated === deployment.application.sensitive
  ))
}

function infrastructureServer(servers, code, seed, application) {
  let pool = servers.filter((server) => server.roleCode === code)
  if (code === 'MGT' && application.sensitive) {
    const dedicated = pool.filter((server) => server.application === application.name)
    if (dedicated.length) pool = dedicated
  }
  return pick(pool, seed)
}

function addProfile(profiles, source, destination, sourceApplication, destinationApplication, variant = 0, deploymentEnvironment = null) {
  profiles.push({
    source, destination, sourceApplication, destinationApplication,
    sourceProcess: roleProcess(source), destinationProcess: roleProcess(destination, true),
    port: destinationPort(destination, variant), deploymentEnvironment,
  })
}

function registerTierConsumer(server, environment) {
  server.consumerEnvironments ??= new Set()
  server.consumerEnvironments.add(environment)
}

function buildConnectionProfiles(applications, deployments, servers, loadBalancers) {
  const profiles = []
  for (const deployment of deployments) {
    const { application, environment } = deployment
    const loadBalancer = loadBalancerForDeployment(deployment, loadBalancers)
    const web = deployment.servers.WEB[0] ?? null
    const app = deploymentServer(deployment, servers, 'APP')
    const database = databaseServerForDeployment(deployment, servers)
    const report = application.hasReporting ? deploymentServer(deployment, servers, 'RPT') : null
    for (const server of [web, app, database, report].filter(Boolean)) registerTierConsumer(server, environment.name)
    database.consumerApplications ??= new Set()
    database.consumerApplications.add(application.name)
    const appName = `${application.name} (${environment.name})`
    if (web) {
      addProfile(profiles, loadBalancer, web, `${application.name} Load Balancer`, `${application.name} Web`, application.id, environment.name)
      addProfile(profiles, web, app, `${application.name} Web`, `${application.name} Application`, application.id, environment.name)
    } else {
      addProfile(profiles, loadBalancer, app, `${application.name} Load Balancer`, `${application.name} Application`, application.id, environment.name)
    }
    addProfile(profiles, app, database, `${application.name} Application`, `${application.name} Database`, 0, environment.name)
    addProfile(profiles, app, infrastructureServer(servers, 'DC', application.id, application), appName, 'Active Directory Domain Services')
    addProfile(profiles, app, infrastructureServer(servers, 'DC', application.id + 1, application), appName, 'Domain Name Service', 1)
    addProfile(profiles, app, infrastructureServer(servers, 'PXY', application.id, application), appName, 'Enterprise Proxy')
    addProfile(profiles, app, infrastructureServer(servers, 'FIL', application.id, application), appName, 'Windows File Services')
    addProfile(profiles, app, infrastructureServer(servers, 'BAK', application.id, application), appName, 'Enterprise Backup')
    addProfile(profiles, app, infrastructureServer(servers, 'MON', application.id, application), appName, 'Infrastructure Monitoring')
    addProfile(profiles, app, infrastructureServer(servers, 'MGT', application.id, application), appName, application.sensitive ? 'Dedicated Secure Management' : 'Infrastructure Management')
    addProfile(profiles, app, infrastructureServer(servers, 'CFG', application.id, application), appName, 'Microsoft Configuration Manager')
    if (application.id % 4 === 0) addProfile(profiles, app, infrastructureServer(servers, 'PRT', application.id, application), appName, 'Enterprise Print Services')
    if (report) {
      addProfile(profiles, app, report, `${application.name} Application`, `${application.name} Reporting`, 0, environment.name)
      addProfile(profiles, report, database, `${application.name} Reporting`, `${application.name} Database`, 0, environment.name)
    }
  }
  return profiles
}

function classifySharedDatabases(servers) {
  const sequences = new Map()
  for (const server of servers.filter((candidate) => databaseCodes.has(candidate.roleCode) && (candidate.consumerApplications?.size ?? 0) > 1)) {
    const key = `${server.environment}:${server.roleCode}`
    const sequence = (sequences.get(key) ?? 0) + 1
    sequences.set(key, sequence)
    server.application = 'Shared DB'
    server.applicationCode = 'SHRDB'
    server.name = `SHRDB-${server.environmentCode}-${server.roleCode}-${String(sequence).padStart(3, '0')}`
    server.armId = `/subscriptions/synthetic/resourceGroups/onprem-${server.environmentCode.toLowerCase()}/providers/Microsoft.HybridCompute/machines/${server.name}`
  }
}

function recommendedSku(server) {
  if (server.cores >= 16) return 'Standard_D16as_v5'
  if (server.cores >= 8) return 'Standard_D8as_v5'
  return 'Standard_D4as_v5'
}

function assessmentValues(server) {
  const computeCost = server.cores * 42
  const storageCost = Math.round(server.storage * 0.08 * 100) / 100
  const securityCost = server.sensitive ? 96 : 34
  const totalCost = computeCost + storageCost + securityCost
  const tags = [
    `Application=${server.application}`, `Environment=${server.environment}`, `Role=${server.role}`,
    `NetworkZone=${server.isolated ? 'Isolated' : 'Corporate'}`, `DataSensitivity=${server.sensitive ? 'High' : 'Standard'}`,
    `OSFamily=${server.osFamily}`, `OSDistribution=${server.osDistribution}`,
  ].join(';')
  const legacyOs = server.osFamily === 'Windows'
    ? ['2012', '2012 R2'].includes(server.osVersion)
    : server.osDistribution === 'RHEL' && server.osVersion.startsWith('7.') || server.osDistribution === 'SLES' && server.osVersion === '14'
  const values = {
    APPLICATION: server.application, SERVER_NAME: server.name, MIGRATION_READINESS: 'Ready with conditions',
    SECURITY_READINESS: server.sensitive ? 'Requires review' : 'Ready', OS_SUPPORT_STATUS: legacyOs ? 'Extended support' : 'Supported',
    SUPPORT_ENDS_IN_MONTHS: legacyOs ? 12 : 38, SUPPORT_END_DATE: legacyOs ? '2027-10-14' : '2029-10-14', RECOMMENDED_STORAGE_SKU: 'Premium SSD v2',
    RECOMMENDED_STORAGE_SIZE_GB: server.storage, RECOMMENDED_NUMBER_OF_CORES: server.cores,
    STORAGE_UTILIZATION_PERCENT: 58 + (server.id % 23), RECOMMENDED_COMPUTE_SKU: recommendedSku(server),
    TOTAL_MONTHLY_COST_USD: totalCost, MONTHLY_COMPUTE_COST_USD: computeCost,
    MONTHLY_STORAGE_COST_USD: storageCost, MONTHLY_SECURITY_COST_USD: securityCost,
    CONFIDENCE_RATING_PERCENT: 95, OPERATING_SYSTEM_NAME: server.osName,
    OS_VERSION: server.osVersion, OS_ARCHITECTURE: 'x64',
    BOOT_TYPE: 'UEFI', TOTAL_DISKS_COUNT: server.storage >= 2048 ? 8 : server.storage >= 1024 ? 4 : 2,
    ONPREM_STORAGE_GB: server.storage, ONPREM_CPU_USAGE_PERCENT: 24 + (server.id % 43),
    ONPREM_MEMORY_USAGE_PERCENT: 38 + (server.id % 39), DISK_READ_IOPS: 500 + (server.id % 9000),
    DISK_WRITE_IOPS: 300 + (server.id % 5000), NETWORK_READ_MBPS: 12 + (server.id % 180),
    NETWORK_WRITE_MBPS: 8 + (server.id % 120), DISK_READ_MBPS: 20 + (server.id % 240),
    DISK_WRITE_MBPS: 15 + (server.id % 180), ONPREM_CORES_COUNT: server.cores,
    ONPREM_MEMORY_MB: server.memory, NETWORK_ADAPTERS_COUNT: server.sensitive ? 2 : 1,
    SOURCE_SYSTEM: 'Synthetic Migration Factory', IP_ADDRESS: server.ip, MAC_ADDRESS: macAddress(server.id),
    TOTAL_ISSUES_COUNT: server.sensitive ? 1 : 0, RESOURCE_TAGS: tags,
    CARBON_EMISSIONS_SCOPE1_MtCO2e: 0, CARBON_EMISSIONS_SCOPE2_MtCO2e: server.cores * 0.0004,
    CARBON_EMISSIONS_SCOPE3_MtCO2e: server.cores * 0.0002, TOTAL_CARBON_EMISSIONS_MtCO2e: server.cores * 0.0006,
    ENVIRONMENT_TYPE: server.environment,
  }
  return assessmentHeaders.map((header) => values[header])
}

async function writeAssessments(outputDirectory, servers) {
  const path = resolve(outputDirectory, 'ServerAssessment-Synthetic-624.csv')
  const stream = createWriteStream(path, { encoding: 'utf8' })
  await writeChunk(stream, csvRow(assessmentHeaders))
  for (const server of servers) await writeChunk(stream, csvRow(assessmentValues(server)))
  await closeStream(stream)
  return path
}

async function writeCoreInfrastructure(outputDirectory, servers, loadBalancers) {
  const path = resolve(outputDirectory, 'CoreInfrastructure-Synthetic.csv')
  const stream = createWriteStream(path, { encoding: 'utf8' })
  await writeChunk(stream, csvRow(['server_name', 'role', 'ip_address', 'load_balancer_ip']))
  for (const server of servers.filter(({ roleCode }) => infrastructureCodes.has(roleCode))) {
    await writeChunk(stream, csvRow([server.name, server.role, server.ip, '']))
  }
  for (const loadBalancer of loadBalancers) await writeChunk(stream, csvRow(['', '', '', loadBalancer.ip]))
  await closeStream(stream)
  return path
}

async function writeNetworkRanges(outputDirectory) {
  const path = resolve(outputDirectory, 'NetworkRanges-Synthetic.csv')
  const stream = createWriteStream(path, { encoding: 'utf8' })
  await writeChunk(stream, csvRow(['network_type', 'ip_range', 'environment', 'description']))
  for (const environment of environments) {
    const isolatedOctet = 90 + (environment.secondOctet / 10 - 2)
    await writeChunk(stream, csvRow(['Office', `10.${environment.secondOctet}.0.0/16`, environment.name, `${environment.name} corporate application network`]))
    await writeChunk(stream, csvRow(['VPN', `10.${isolatedOctet}.0.0/16`, environment.name, `${environment.name} isolated sensitive-application network`]))
  }
  await closeStream(stream)
  return path
}

async function writeApplicationCatalog(outputDirectory, applications, deployments, servers) {
  const path = resolve(outputDirectory, 'ApplicationCatalog-Synthetic-96.csv')
  const stream = createWriteStream(path, { encoding: 'utf8' })
  const headers = ['Application ID', 'Application Name', 'Application Code', 'Business Owner', 'Highly Sensitive', 'Network Zone', 'Environments', 'Pre-prod Mirrors Prod', 'Server Count']
  await writeChunk(stream, csvRow(headers))
  for (const application of applications) {
    const appDeployments = deployments.filter((deployment) => deployment.application === application)
    const serverCount = servers.filter((server) => server.application === application.name).length
    await writeChunk(stream, csvRow([
      application.id, application.name, application.code, application.businessOwner, application.sensitive ? 'Yes' : 'No',
      application.sensitive ? 'Isolated' : 'Corporate', appDeployments.map(({ environment }) => environment.name).join('|'),
      application.hasPreProd ? 'Yes' : 'Not applicable', serverCount,
    ]))
  }
  await closeStream(stream)
  return path
}

async function writeSharedDatabaseInventory(outputDirectory, servers) {
  const path = resolve(outputDirectory, 'SharedDatabaseInventory-Synthetic.csv')
  const stream = createWriteStream(path, { encoding: 'utf8' })
  const headers = ['Server Name', 'IP Address', 'Database Engine', 'Environment', 'Network Zone', 'Application Count', 'Applications']
  await writeChunk(stream, csvRow(headers))
  const sharedDatabases = servers
    .filter((server) => databaseCodes.has(server.roleCode) && (server.consumerApplications?.size ?? 0) > 1)
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const server of sharedDatabases) {
    await writeChunk(stream, csvRow([
      server.name, server.ip, server.role, server.environment, server.isolated ? 'Isolated' : 'Corporate',
      server.consumerApplications.size, [...server.consumerApplications].sort().join('|'),
    ]))
  }
  await closeStream(stream)
  return { path, sharedDatabases }
}

function dependencyValues(profile, rowIndex) {
  const observedDate = new Date(Date.UTC(2026, 6, 1 + (rowIndex % 31))).toISOString().slice(0, 10)
  return [
    observedDate, 'MIGRATION-APPLIANCE-01', profile.source.armId, profile.source.roleCode === 'LB' ? '' : profile.source.name, profile.source.ip,
    profile.source.application === 'Shared DB' ? 'Shared DB' : profile.sourceApplication, profile.sourceProcess, profile.destination.armId, profile.destination.name,
    profile.destination.ip, profile.destination.application === 'Shared DB' ? 'Shared DB' : profile.destinationApplication, profile.destinationProcess, profile.port,
    1 + ((rowIndex * 17 + profile.source.id + profile.destination.id) % 5000),
  ]
}

async function writeDependencies(outputDirectory, profiles, dependencyCount, rowsPerFile) {
  const files = []
  let rowsWritten = 0
  let fileNumber = 1
  while (rowsWritten < dependencyCount) {
    const fileRows = Math.min(rowsPerFile, dependencyCount - rowsWritten)
    const path = resolve(outputDirectory, `DependencyExport-Synthetic-${String(fileNumber).padStart(2, '0')}.csv`)
    const stream = createWriteStream(path, { encoding: 'utf8', highWaterMark: 1024 * 1024 })
    await writeChunk(stream, csvRow(dependencyHeaders))
    for (let index = 0; index < fileRows; index++) {
      const globalIndex = rowsWritten + index
      const profile = profiles[globalIndex % profiles.length]
      await writeChunk(stream, csvRow(dependencyValues(profile, globalIndex)))
    }
    await closeStream(stream)
    files.push({ path, rows: fileRows })
    rowsWritten += fileRows
    fileNumber++
    console.log(`Generated ${rowsWritten.toLocaleString()} of ${dependencyCount.toLocaleString()} dependency rows`)
  }
  return files
}

function countBy(values, selector) {
  return Object.fromEntries([...new Set(values.map(selector))].map((key) => [key, values.filter((value) => selector(value) === key).length]))
}

function validateModel(applications, deployments, servers, loadBalancers, profiles, dependencyCount) {
  const roleCounts = countBy(servers, ({ role }) => role)
  const expectedRoleCounts = Object.fromEntries(roleSpecs.map(({ role, count }) => [role, count]))
  const uniqueNames = new Set(servers.map(({ name }) => name))
  const uniqueIps = new Set(servers.map(({ ip }) => ip))
  const preProdDeployments = deployments.filter(({ environment }) => environment.name === 'Pre-prod').length
  const sharedDatabases = servers.filter((server) => databaseCodes.has(server.roleCode) && (server.consumerApplications?.size ?? 0) > 1)
  const applicationTierServers = servers.filter((server) => ['WEB', 'APP', 'RPT'].includes(server.roleCode) || databaseCodes.has(server.roleCode))
  const applicationTierProfiles = profiles.filter(({ source, destination }) => (
    ['WEB', 'APP', 'RPT'].includes(source.roleCode) || databaseCodes.has(source.roleCode)
  ) && (
    ['WEB', 'APP', 'RPT'].includes(destination.roleCode) || databaseCodes.has(destination.roleCode)
  ))
  const windowsServers = servers.filter(({ osFamily }) => osFamily === 'Windows')
  const linuxServers = servers.filter(({ osFamily }) => osFamily === 'Linux')
  const windowsVersionCounts = countBy(windowsServers, ({ osVersion }) => osVersion)
  const linuxDistributionCounts = countBy(linuxServers, ({ osDistribution }) => osDistribution)
  const linuxVersionCounts = countBy(linuxServers, ({ osDistribution, osVersion }) => `${osDistribution} ${osVersion}`)
  const legacyWindowsCount = windowsServers.filter(({ osVersion }) => ['2012', '2012 R2'].includes(osVersion)).length
  const windows2025Count = windowsServers.filter(({ osVersion }) => osVersion === '2025').length
  const coreServers = servers.filter(({ roleCode }) => infrastructureCodes.has(roleCode))
  const allowedLinuxVersions = new Set(['RHEL 7.9', 'RHEL 8.10', 'RHEL 9.5', 'SLES 14', 'SLES 15', 'SLES 16'])
  const roleCodes = new Set(roleSpecs.map(({ code }) => code))
  const destinationCoreRoles = new Set(profiles.map(({ destination }) => destination.roleCode).filter((code) => infrastructureCodes.has(code)))
  const preProdSizingMatchesProd = applications.filter(({ hasPreProd }) => hasPreProd).every((application) => {
    const preProd = deployments.find((deployment) => deployment.application === application && deployment.environment.name === 'Pre-prod')?.servers.APP[0]
    const prod = deployments.find((deployment) => deployment.application === application && deployment.environment.name === 'Prod')?.servers.APP[0]
    return preProd && prod && preProd.cores === prod.cores && preProd.memory === prod.memory && preProd.storage === prod.storage
  })
  const assertions = {
    serverCount: servers.length === 624,
    uniqueServerNames: uniqueNames.size === servers.length,
    uniqueIpAddresses: uniqueIps.size === servers.length,
    roleCounts: JSON.stringify(roleCounts) === JSON.stringify(expectedRoleCounts),
    applicationCount: applications.length >= 88,
    environmentCount: new Set(deployments.map(({ environment }) => environment.name)).size === 4,
    optionalPreProd: preProdDeployments > 0 && preProdDeployments < applications.length,
    applicationServerPerDeployment: deployments.every(({ servers: deploymentServers }) => deploymentServers.APP.length === 1),
    preProdSizingMatchesProd,
    reportPercentage: roleCounts.Report / servers.length < 0.1,
    sqlServers: roleCounts['SQL Server'] >= 40,
    oracleServers: roleCounts['Oracle Database'] >= 50,
    mysqlServers: roleCounts['MySQL Database'] >= 10,
    postgresqlServers: roleCounts['PostgreSQL Database'] >= 6,
    sensitiveApplications: applications.filter(({ sensitive }) => sensitive).length >= sensitiveApplicationCount,
    isolatedServers: servers.some(({ isolated }) => isolated),
    sharedDatabases: sharedDatabases.length >= 8,
    sharedDatabaseApplicationName: sharedDatabases.every(({ application }) => application === 'Shared DB'),
    sharedDatabaseNaming: sharedDatabases.every(({ name }) => /^SHRDB-(DEV|TST|PPD|PRD)-(SQL|ORA|MYQ|PGQ)-\d{3}$/.test(name)),
    sharedDatabaseApplications: new Set(sharedDatabases.flatMap((server) => [...server.consumerApplications])).size >= 20,
    tierServersSingleEnvironment: applicationTierServers.every((server) => (server.consumerEnvironments?.size ?? 0) <= 1),
    tierDependenciesStayInEnvironment: applicationTierProfiles.every(({ source, destination, deploymentEnvironment }) => (
      source.environment === deploymentEnvironment && destination.environment === deploymentEnvironment
    )),
    serverNamingConvention: servers.every(({ name, environmentCode, roleCode }) => name.includes(`-${environmentCode}-${roleCode}-`) && roleCodes.has(roleCode)),
    privateIpAddresses: servers.every(({ ip }) => ip.startsWith('10.')) && loadBalancers.every(({ ip }) => ip.startsWith('10.')),
    loadBalancerCount: loadBalancers.length === environments.length * 2,
    loadBalancerTopologyCoverage: profiles.filter(({ source }) => source.roleCode === 'LB').length === deployments.length,
    coreServiceTopologyCoverage: [...infrastructureCodes].every((code) => destinationCoreRoles.has(code)),
    sensitiveDedicatedManagement: applications.filter(({ sensitive }) => sensitive).every((application) => servers.some(({ roleCode, application: serverApplication, isolated }) => (
      roleCode === 'MGT' && serverApplication === application.name && isolated
    ))),
    windowsLinuxRatio: windowsServers.length === 424 && linuxServers.length === 200,
    windowsDatacenterEdition: windowsServers.every(({ osName }) => osName.endsWith('Datacenter')),
    legacyWindowsMaximumFivePercent: legacyWindowsCount / windowsServers.length <= 0.05,
    windows2025MaximumTwentyPercent: windows2025Count / windowsServers.length <= 0.2,
    linuxRhelSlesRatio: linuxDistributionCounts.RHEL === 140 && linuxDistributionCounts.SLES === 60,
    allowedLinuxVersions: linuxServers.every(({ osDistribution, osVersion }) => allowedLinuxVersions.has(`${osDistribution} ${osVersion}`)),
    modernCoreOperatingSystems: coreServers.every(({ osFamily, osDistribution, osVersion }) => osFamily === 'Windows'
      ? ['2019', '2022', '2025'].includes(osVersion)
      : osDistribution === 'RHEL' ? ['8.10', '9.5'].includes(osVersion) : ['15', '16'].includes(osVersion)),
    dependencyCount: dependencyCount >= 2_000_000 || process.argv.some((argument) => argument.startsWith('--dependency-count=')),
  }
  const failures = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name)
  if (failures.length) {
    throw new Error(`Dataset model validation failed: ${failures.join(', ')}. Observed ${sharedDatabases.length} shared database servers serving ${new Set(sharedDatabases.flatMap((server) => [...server.consumerApplications])).size} applications.`)
  }
  return {
    assertions, roleCounts, expectedRoleCounts, preProdDeployments, sharedDatabases,
    operatingSystems: {
      families: { Windows: windowsServers.length, Linux: linuxServers.length },
      windowsVersions: windowsVersionCounts, linuxDistributions: linuxDistributionCounts,
      linuxVersions: linuxVersionCounts,
      percentages: {
        Windows: Number((windowsServers.length / servers.length * 100).toFixed(2)),
        Linux: Number((linuxServers.length / servers.length * 100).toFixed(2)),
        legacyWindows: Number((legacyWindowsCount / windowsServers.length * 100).toFixed(2)),
        windows2025: Number((windows2025Count / windowsServers.length * 100).toFixed(2)),
        rhelWithinLinux: Number((linuxDistributionCounts.RHEL / linuxServers.length * 100).toFixed(2)),
        slesWithinLinux: Number((linuxDistributionCounts.SLES / linuxServers.length * 100).toFixed(2)),
      },
    },
  }
}

async function main() {
  const options = parseArguments()
  if (!Number.isInteger(options.dependencyCount) || options.dependencyCount < 1) throw new Error('dependency-count must be a positive integer')
  if (!Number.isInteger(options.rowsPerFile) || options.rowsPerFile < 1) throw new Error('rows-per-file must be a positive integer')
  await mkdir(options.outputDirectory, { recursive: true })
  const applications = buildApplications()
  const deployments = buildDeployments(applications)
  const servers = buildServers(applications, deployments)
  const loadBalancers = buildLoadBalancers()
  const profiles = buildConnectionProfiles(applications, deployments, servers, loadBalancers)
  classifySharedDatabases(servers)
  const validation = validateModel(applications, deployments, servers, loadBalancers, profiles, options.dependencyCount)
  const assessmentPath = await writeAssessments(options.outputDirectory, servers)
  const coreInfrastructurePath = await writeCoreInfrastructure(options.outputDirectory, servers, loadBalancers)
  const networkRangesPath = await writeNetworkRanges(options.outputDirectory)
  const catalogPath = await writeApplicationCatalog(options.outputDirectory, applications, deployments, servers)
  const sharedDatabaseInventory = await writeSharedDatabaseInventory(options.outputDirectory, servers)
  const dependencyFiles = await writeDependencies(options.outputDirectory, profiles, options.dependencyCount, options.rowsPerFile)
  const manifest = {
    generatedAt: new Date().toISOString(), seed: 'migration-factory-v1', syntheticData: true,
    counts: {
      applications: applications.length, applicationDeployments: deployments.length, servers: servers.length,
      dependencyRecords: options.dependencyCount, connectionProfiles: profiles.length,
      highlySensitiveApplications: applications.filter(({ sensitive }) => sensitive).length,
      isolatedServers: servers.filter(({ isolated }) => isolated).length,
      loadBalancerIps: loadBalancers.length,
      sharedDatabaseServers: sharedDatabaseInventory.sharedDatabases.length,
      applicationsUsingSharedDatabases: new Set(sharedDatabaseInventory.sharedDatabases.flatMap((server) => [...server.consumerApplications])).size,
    },
    environments: countBy(deployments, ({ environment }) => environment.name),
    roles: validation.roleCounts,
    databaseEngines: {
      'SQL Server': validation.roleCounts['SQL Server'], Oracle: validation.roleCounts['Oracle Database'],
      MySQL: validation.roleCounts['MySQL Database'], PostgreSQL: validation.roleCounts['PostgreSQL Database'],
    },
    operatingSystems: validation.operatingSystems,
    reportServerPercentage: Number((validation.roleCounts.Report / servers.length * 100).toFixed(2)),
    validation: validation.assertions,
    sharedDatabasesByEnvironment: countBy(sharedDatabaseInventory.sharedDatabases, ({ environment }) => environment),
    sharedDatabasesByEngine: countBy(sharedDatabaseInventory.sharedDatabases, ({ role }) => role),
    files: {
      assessment: assessmentPath, applicationCatalog: catalogPath,
      sharedDatabaseInventory: sharedDatabaseInventory.path, coreInfrastructure: coreInfrastructurePath,
      networkRanges: networkRangesPath, dependencies: dependencyFiles,
    },
  }
  const manifestPath = resolve(options.outputDirectory, 'dataset-manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`Dataset generated in ${options.outputDirectory}`)
  console.log(JSON.stringify(manifest.counts, null, 2))
}

await main()