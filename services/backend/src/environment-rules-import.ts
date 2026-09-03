import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'
import { validateEnvironmentRules, type EnvironmentRuleInput } from './environment-identification.js'

type RawRow = Record<string, unknown>
type RuleColumn = 'priority' | 'environment' | 'field' | 'operator' | 'value'

const MAX_RULES = 200
const columnAliases: Record<RuleColumn, ReadonlySet<string>> = {
  priority: new Set(['priority', 'order', 'precedence', 'rank']),
  environment: new Set(['environment', 'environmentname', 'targetenvironment', 'proposedenvironment']),
  field: new Set(['field', 'assessmentfield', 'rulefield', 'attribute']),
  operator: new Set(['operator', 'condition', 'ruleoperator', 'comparison']),
  value: new Set(['value', 'matchvalue', 'rulevalue', 'pattern', 'criteria']),
}

const fieldAliases = new Map<string, EnvironmentRuleInput['field']>([
  ['servername', 'serverName'], ['server', 'serverName'], ['hostname', 'serverName'],
  ['ipaddress', 'ipAddress'], ['ip', 'ipAddress'],
  ['application', 'application'], ['applicationname', 'application'], ['app', 'application'],
  ['resourcetags', 'resourceTags'], ['tags', 'resourceTags'],
  ['sourcesystem', 'sourceSystem'], ['source', 'sourceSystem'],
  ['operatingsystem', 'operatingSystemName'], ['operatingsystemname', 'operatingSystemName'], ['os', 'operatingSystemName'],
  ['migrationreadiness', 'migrationReadiness'], ['securityreadiness', 'securityReadiness'],
  ['ossupportstatus', 'osSupportStatus'], ['supportstatus', 'osSupportStatus'],
])

const operatorAliases = new Map<string, EnvironmentRuleInput['operator']>([
  ['equals', 'equals'], ['equal', 'equals'], ['is', 'equals'], ['=', 'equals'],
  ['contains', 'contains'], ['includes', 'contains'],
  ['startswith', 'startsWith'], ['beginswith', 'startsWith'],
  ['endswith', 'endsWith'],
  ['glob', 'glob'], ['matchespattern', 'glob'], ['pattern', 'glob'],
  ['cidr', 'cidr'], ['isincidrrange', 'cidr'], ['inrange', 'cidr'],
])

const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/[^a-z0-9=]+/g, '')
const text = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return String(value).trim()
  if ('result' in value) return text((value as { result: unknown }).result)
  if ('text' in value) return text((value as { text: unknown }).text)
  if ('richText' in value) return (value as { richText: Array<{ text?: unknown }> }).richText.map(({ text: part }) => text(part)).join('').trim()
  return ''
}

function mappedHeaders(headers: string[]): Map<RuleColumn, number> {
  const result = new Map<RuleColumn, number>()
  headers.forEach((header, index) => {
    const normalized = normalize(header)
    for (const [column, aliases] of Object.entries(columnAliases) as Array<[RuleColumn, ReadonlySet<string>]>) {
      if (aliases.has(normalized) && !result.has(column)) result.set(column, index)
    }
  })
  return result
}

function parseRows(rows: RawRow[]): EnvironmentRuleInput[] {
  if (rows.length > MAX_RULES) throw new Error(`The workbook contains more than ${MAX_RULES} environment rules.`)
  const rules = rows.map((row, index) => {
    const values = new Map<string, string>()
    for (const [header, value] of Object.entries(row)) values.set(normalize(header), text(value))
    const valueFor = (column: RuleColumn) => {
      for (const alias of columnAliases[column]) {
        const value = values.get(alias)
        if (value !== undefined) return value
      }
      return ''
    }
    const rawField = valueFor('field')
    const rawOperator = valueFor('operator')
    const field = fieldAliases.get(normalize(rawField))
    const operator = operatorAliases.get(normalize(rawOperator))
    if (!field) throw new Error(`Row ${index + 2} has an unsupported assessment field: ${rawField || '(blank)'}.`)
    if (!operator) throw new Error(`Row ${index + 2} has an unsupported condition: ${rawOperator || '(blank)'}.`)
    return {
      priority: Number(valueFor('priority')),
      environment: valueFor('environment'),
      field,
      operator,
      value: valueFor('value'),
    }
  })
  return validateEnvironmentRules(rules)
}

async function csvRows(filePath: string): Promise<RawRow[]> {
  const rows: RawRow[] = []
  const parser = createReadStream(filePath).pipe(parse({
    bom: true, columns: true, relax_quotes: true, skip_empty_lines: true, trim: true,
  }))
  for await (const row of parser) {
    rows.push(row as RawRow)
    if (rows.length > MAX_RULES) throw new Error(`The CSV contains more than ${MAX_RULES} environment rules.`)
  }
  return rows
}

async function xlsxRows(filePath: string): Promise<RawRow[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  let selected: { worksheet: ExcelJS.Worksheet; rowNumber: number; headers: string[]; score: number } | null = null
  for (const worksheet of workbook.worksheets) {
    for (let rowNumber = 1; rowNumber <= Math.min(25, worksheet.rowCount); rowNumber++) {
      const headers = (worksheet.getRow(rowNumber).values as unknown[]).slice(1).map(text)
      const score = mappedHeaders(headers).size
      if (score > (selected?.score ?? 0)) selected = { worksheet, rowNumber, headers, score }
    }
  }
  if (!selected || selected.score < 5) {
    throw new Error('The workbook requires Priority, Environment, Field, Operator, and Value columns.')
  }
  const rows: RawRow[] = []
  selected.worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= selected!.rowNumber) return
    const values = (row.values as unknown[]).slice(1)
    if (values.every((value) => !text(value))) return
    rows.push(Object.fromEntries(selected!.headers.map((header, index) => [header, values[index] ?? ''])))
    if (rows.length > MAX_RULES) throw new Error(`The workbook contains more than ${MAX_RULES} environment rules.`)
  })
  return rows
}

export async function parseEnvironmentRulesFile(filePath: string): Promise<EnvironmentRuleInput[]> {
  const extension = extname(filePath).toLocaleLowerCase()
  const rows = extension === '.csv' ? await csvRows(filePath) : extension === '.xlsx' ? await xlsxRows(filePath) : null
  if (!rows) throw new Error('The workbook must be a CSV or XLSX file.')
  if (!rows.length) throw new Error('The workbook contains no environment rules.')
  return parseRows(rows)
}