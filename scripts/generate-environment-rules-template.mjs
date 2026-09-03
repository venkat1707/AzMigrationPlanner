import ExcelJS from 'exceljs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(scriptDirectory, '../services/frontend/public/environment-identification-rules-template.xlsx')

const workbook = new ExcelJS.Workbook()
workbook.creator = 'Cloud Accelerate Factory'
workbook.subject = 'Environment identification rule import template'
workbook.created = new Date()

const instructions = workbook.addWorksheet('Instructions', { views: [{ showGridLines: false }] })
instructions.columns = [{ width: 24 }, { width: 95 }]
instructions.addRows([
  ['Environment rules template', 'Complete the Rules worksheet, then upload this XLSX file on the Environment Identification page.'],
  ['Required columns', 'Priority, Environment, Field, Operator, and Value are required for every rule.'],
  ['Priority', 'Enter a whole number from 1 to 9999. Lower numbers run first. Rules at the same priority may create a conflict.'],
  ['Environment', 'Choose a common environment from the dropdown or type a different environment name.'],
  ['Field', 'Choose the server-assessment field that the rule evaluates.'],
  ['Operator', 'Choose the comparison. CIDR is valid only when Field is IP Address.'],
  ['Value', 'Enter the text, pattern, or CIDR range to match. Pattern examples use * for any characters and ? for one character.'],
  ['Safety', 'Spreadsheet content is treated as data. The importer validates every field and operator before preview or apply.'],
])
instructions.getRow(1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
instructions.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
instructions.getRow(1).height = 28
for (let row = 2; row <= instructions.rowCount; row++) {
  instructions.getCell(row, 1).font = { bold: true, color: { argb: 'FF172033' } }
  instructions.getCell(row, 2).alignment = { wrapText: true, vertical: 'top' }
}

const rules = workbook.addWorksheet('Rules', {
  views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  properties: { defaultRowHeight: 21 },
})
rules.columns = [
  { header: 'Priority', key: 'priority', width: 13 },
  { header: 'Environment', key: 'environment', width: 24 },
  { header: 'Field', key: 'field', width: 28 },
  { header: 'Operator', key: 'operator', width: 22 },
  { header: 'Value', key: 'value', width: 44 },
]
rules.addRows([
  { priority: 10, environment: 'Production', field: 'Server Name', operator: 'Matches Pattern', value: '*-PRD-*' },
  { priority: 20, environment: 'Production', field: 'Resource Tags', operator: 'Contains', value: 'environment=production' },
  { priority: 30, environment: 'UAT', field: 'Application', operator: 'Equals', value: 'Payments UAT' },
  { priority: 40, environment: 'Development', field: 'IP Address', operator: 'CIDR', value: '10.20.0.0/16' },
  { priority: 50, environment: 'Development', field: 'Source System', operator: 'Starts With', value: 'vCenter-DEV' },
  { priority: 60, environment: 'Disaster Recovery', field: 'Server Name', operator: 'Ends With', value: '-DR' },
])
rules.autoFilter = { from: 'A1', to: 'E201' }
rules.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
rules.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
rules.getRow(1).height = 25
for (let row = 2; row <= 201; row++) {
  rules.getCell(row, 1).dataValidation = {
    type: 'whole', operator: 'between', formulae: [1, 9999], allowBlank: false,
    showErrorMessage: true, errorTitle: 'Invalid priority', error: 'Enter a whole number from 1 to 9999.',
  }
  rules.getCell(row, 2).dataValidation = {
    type: 'list', allowBlank: false, formulae: ['Lists!$A$2:$A$11'],
    showInputMessage: true, promptTitle: 'Environment', prompt: 'Choose an option or type a custom environment name.',
    showErrorMessage: false,
  }
  rules.getCell(row, 3).dataValidation = {
    type: 'list', allowBlank: false, formulae: ['Lists!$B$2:$B$10'],
    showErrorMessage: true, errorTitle: 'Invalid field', error: 'Choose a supported assessment field from the dropdown.',
  }
  rules.getCell(row, 4).dataValidation = {
    type: 'list', allowBlank: false, formulae: ['Lists!$C$2:$C$7'],
    showInputMessage: true, promptTitle: 'Operator', prompt: 'CIDR can be used only with IP Address.',
    showErrorMessage: true, errorTitle: 'Invalid operator', error: 'Choose a supported operator from the dropdown.',
  }
  rules.getCell(row, 5).dataValidation = {
    type: 'textLength', operator: 'between', formulae: [1, 1000], allowBlank: false,
    showErrorMessage: true, errorTitle: 'Invalid value', error: 'Enter a value containing 1 to 1000 characters.',
  }
  for (let column = 1; column <= 5; column++) {
    rules.getCell(row, column).border = { bottom: { style: 'hair', color: { argb: 'FFD8E0EC' } } }
  }
}

const lists = workbook.addWorksheet('Lists', { state: 'veryHidden' })
lists.getColumn(1).values = ['Environment', 'Production', 'UAT', 'Development', 'Test', 'Quality Assurance', 'Staging', 'Disaster Recovery', 'Training', 'Sandbox', 'Shared']
lists.getColumn(2).values = ['Field', 'Server Name', 'IP Address', 'Application', 'Resource Tags', 'Source System', 'Operating System', 'Migration Readiness', 'Security Readiness', 'OS Support Status']
lists.getColumn(3).values = ['Operator', 'Equals', 'Contains', 'Starts With', 'Ends With', 'Matches Pattern', 'CIDR']

await workbook.xlsx.writeFile(outputPath)
console.log(`Generated ${outputPath}`)
