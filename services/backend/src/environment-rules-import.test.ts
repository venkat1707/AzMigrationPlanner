import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { parseEnvironmentRulesFile } from './environment-rules-import.js'

async function withDirectory(check: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'environment-rules-'))
  try { await check(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('imports environment rules from CSV with friendly headings and aliases', async () => {
  await withDirectory(async (directory) => {
    const filePath = join(directory, 'rules.csv')
    await writeFile(filePath, [
      'Order,Target Environment,Assessment Field,Condition,Match Value',
      '10,Production,Server Name,Matches Pattern,*-PRD-*',
      '20,Development,IP Address,CIDR,10.20.0.0/16',
    ].join('\n'))
    const rules = await parseEnvironmentRulesFile(filePath)
    assert.deepEqual(rules, [
      { priority: 10, environment: 'Production', field: 'serverName', operator: 'glob', value: '*-PRD-*' },
      { priority: 20, environment: 'Development', field: 'ipAddress', operator: 'cidr', value: '10.20.0.0/16' },
    ])
  })
})

test('finds an XLSX rule table after an instruction sheet and title rows', async () => {
  await withDirectory(async (directory) => {
    const filePath = join(directory, 'rules.xlsx')
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Instructions').addRow(['Environment identification rules'])
    const sheet = workbook.addWorksheet('Rules')
    sheet.addRow(['Rule inventory'])
    sheet.addRow([])
    sheet.addRow(['Priority', 'Environment', 'Field', 'Operator', 'Value'])
    sheet.addRow([10, 'UAT', 'Application', 'Equals', 'Payments'])
    await workbook.xlsx.writeFile(filePath)
    assert.deepEqual(await parseEnvironmentRulesFile(filePath), [
      { priority: 10, environment: 'UAT', field: 'application', operator: 'equals', value: 'Payments' },
    ])
  })
})

test('treats SQL and HTML metacharacters as inert rule data', async () => {
  await withDirectory(async (directory) => {
    const filePath = join(directory, 'rules.csv')
    await writeFile(filePath, [
      'Priority,Environment,Field,Operator,Value',
      "10,\"<script>alert(1)</script>\",Application,Equals,\"x'; DROP TABLE server_assessments; --\"",
    ].join('\n'))
    const [rule] = await parseEnvironmentRulesFile(filePath)
    assert.equal(rule?.environment, '<script>alert(1)</script>')
    assert.equal(rule?.value, "x'; DROP TABLE server_assessments; --")
  })
})

test('rejects unsupported fields and operators', async () => {
  await withDirectory(async (directory) => {
    const filePath = join(directory, 'rules.csv')
    await writeFile(filePath, 'Priority,Environment,Field,Operator,Value\n10,Prod,SQL,Execute,SELECT 1\n')
    await assert.rejects(parseEnvironmentRulesFile(filePath), /unsupported assessment field/)
  })
})