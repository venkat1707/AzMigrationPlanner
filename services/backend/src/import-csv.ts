import { basename, resolve } from 'node:path'
import { closeDatabase } from './db.js'
import { importDependencyFile, validateDependencyFile } from './dependency-import.js'

async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error('Usage: npm run import -- <path-to-csv>')
  const filePath = resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2])
  if (process.argv.includes('--validate-only')) {
    const rowCount = await validateDependencyFile(filePath)
    console.log(`File validation complete: ${rowCount.toLocaleString()} rows.`)
    return
  }
  const result = await importDependencyFile(filePath, basename(filePath))
  console.log(`Import complete: ${result.rowsImported.toLocaleString()} rows.`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(closeDatabase)