import ipaddr from 'ipaddr.js'

export const environmentRuleFields = [
  'serverName', 'ipAddress', 'application', 'resourceTags', 'sourceSystem', 'operatingSystemName',
  'migrationReadiness', 'securityReadiness', 'osSupportStatus',
] as const
export const environmentRuleOperators = ['equals', 'contains', 'startsWith', 'endsWith', 'glob', 'cidr'] as const

export type EnvironmentRuleField = (typeof environmentRuleFields)[number]
export type EnvironmentRuleOperator = (typeof environmentRuleOperators)[number]
export type EnvironmentRuleInput = {
  environment: string
  priority: number
  field: EnvironmentRuleField
  operator: EnvironmentRuleOperator
  value: string
}

export type AssessmentIdentity = {
  id: number
  serverName: string
  ipAddress: string | null
  application: string | null
  coHostedApplications: string[]
  resourceTags: string | null
  sourceSystem: string | null
  operatingSystemName: string | null
  migrationReadiness: string | null
  securityReadiness: string | null
  osSupportStatus: string | null
  currentEnvironment: string | null
}

export type EnvironmentMatch = AssessmentIdentity & {
  status: 'matched' | 'conflict' | 'unmatched'
  proposedEnvironment: string | null
  matchedEnvironments: string[]
  matchedBy: string[]
  matchedPriority: number | null
}

type CompiledRule = EnvironmentRuleInput & { matches: (assessment: AssessmentIdentity) => boolean }

export function validateEnvironmentRules(input: unknown): EnvironmentRuleInput[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('Add at least one environment rule.')
  if (input.length > 200) throw new Error('No more than 200 environment rules can be evaluated at once.')

  return input.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`Rule ${index + 1} is invalid.`)
    const candidate = value as Record<string, unknown>
    const environment = typeof candidate.environment === 'string' ? candidate.environment.trim() : ''
    const priority = Number(candidate.priority)
    const field = candidate.field as EnvironmentRuleField
    const operator = candidate.operator as EnvironmentRuleOperator
    const ruleValue = typeof candidate.value === 'string' ? candidate.value.trim() : ''
    if (!environment || environment.length > 100) throw new Error(`Rule ${index + 1} requires an environment of 100 characters or fewer.`)
    if (!Number.isInteger(priority) || priority < 1 || priority > 9999) throw new Error(`Rule ${index + 1} requires a priority from 1 to 9999.`)
    if (!environmentRuleFields.includes(field)) throw new Error(`Rule ${index + 1} has an unsupported assessment field.`)
    if (!environmentRuleOperators.includes(operator)) throw new Error(`Rule ${index + 1} has an unsupported operator.`)
    if (!ruleValue || ruleValue.length > 1000) throw new Error(`Rule ${index + 1} requires a value of 1000 characters or fewer.`)
    if (operator === 'cidr') {
      if (field !== 'ipAddress') throw new Error(`Rule ${index + 1} can use CIDR only with IP address.`)
      try { ipaddr.parseCIDR(ruleValue) } catch { throw new Error(`Rule ${index + 1} contains an invalid CIDR range: ${ruleValue}.`) }
    }
    return { environment, priority, field, operator, value: ruleValue }
  }).sort((left, right) => left.priority - right.priority)
}

export function identifyServerEnvironments(assessments: AssessmentIdentity[], rules: EnvironmentRuleInput[]): EnvironmentMatch[] {
  const compiledRules = rules.map((rule) => ({ ...rule, matches: compileRule(rule) }))
  return assessments.map((assessment) => identifyEnvironment(assessment, compiledRules))
}

function identifyEnvironment(assessment: AssessmentIdentity, rules: CompiledRule[]): EnvironmentMatch {
  const matches = rules.filter((rule) => rule.matches(assessment))
  const matchedPriority = matches.length ? Math.min(...matches.map(({ priority }) => priority)) : null
  const winningMatches = matchedPriority === null ? [] : matches.filter(({ priority }) => priority === matchedPriority)
  const environments = new Map<string, { label: string; evidence: Set<string> }>()
  for (const rule of winningMatches) {
    const key = rule.environment.toLocaleLowerCase()
    const match = environments.get(key) ?? { label: rule.environment, evidence: new Set<string>() }
    match.evidence.add(`Priority ${rule.priority} · ${fieldLabel(rule.field)} ${operatorLabel(rule.operator)} ${rule.value}`)
    environments.set(key, match)
  }
  const matchedEnvironments = [...environments.values()].map(({ label }) => label)
  const proposedEnvironment = matchedEnvironments.length === 1 ? matchedEnvironments[0]! : null
  return {
    ...assessment,
    status: matchedEnvironments.length === 0 ? 'unmatched' : matchedEnvironments.length === 1 ? 'matched' : 'conflict',
    proposedEnvironment,
    matchedEnvironments,
    matchedBy: [...environments.values()].flatMap(({ label, evidence }) => [...evidence].map((item) => `${label} - ${item}`)),
    matchedPriority,
  }
}

function compileRule(rule: EnvironmentRuleInput): (assessment: AssessmentIdentity) => boolean {
  if (rule.operator === 'cidr') {
    const network = ipaddr.parseCIDR(rule.value)
    return (assessment) => parseAddresses(assessment.ipAddress).some((address) => addressMatchesNetwork(address, network))
  }
  const expected = rule.value.toLocaleLowerCase()
  const matcher = rule.operator === 'glob' ? globToRegExp(rule.value) : null
  const matchesValue = (rawValue: string): boolean => {
    const actual = rawValue.toLocaleLowerCase()
    if (rule.operator === 'equals') return actual === expected
    if (rule.operator === 'contains') return actual.includes(expected)
    if (rule.operator === 'startsWith') return actual.startsWith(expected)
    if (rule.operator === 'endsWith') return actual.endsWith(expected)
    return matcher!.test(rawValue)
  }
  // A server can host more than one application, so an application rule must match on any of them, not just the primary one.
  if (rule.field === 'application') {
    return (assessment) => [assessment.application, ...assessment.coHostedApplications].some((value) => matchesValue(String(value ?? '')))
  }
  return (assessment) => matchesValue(String(assessment[rule.field] ?? ''))
}

function fieldLabel(field: EnvironmentRuleField): string {
  return ({ serverName: 'Server name', ipAddress: 'IP address', application: 'Application', resourceTags: 'Resource tags', sourceSystem: 'Source system', operatingSystemName: 'Operating system', migrationReadiness: 'Migration readiness', securityReadiness: 'Security readiness', osSupportStatus: 'OS support status' })[field]
}

function operatorLabel(operator: EnvironmentRuleOperator): string {
  return ({ equals: 'equals', contains: 'contains', startsWith: 'starts with', endsWith: 'ends with', glob: 'matches', cidr: 'is in' })[operator]
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function parseAddresses(value: string | null): Array<ipaddr.IPv4 | ipaddr.IPv6> {
  if (!value) return []
  return value.split(/[\s,;]+/).flatMap((candidate) => {
    try { return [ipaddr.parse(candidate.trim())] } catch { return [] }
  })
}

function addressMatchesNetwork(address: ipaddr.IPv4 | ipaddr.IPv6, network: [ipaddr.IPv4 | ipaddr.IPv6, number]): boolean {
  if (address.kind() === 'ipv4' && network[0].kind() === 'ipv4') return (address as ipaddr.IPv4).match([network[0] as ipaddr.IPv4, network[1]])
  if (address.kind() === 'ipv6' && network[0].kind() === 'ipv6') return (address as ipaddr.IPv6).match([network[0] as ipaddr.IPv6, network[1]])
  return false
}