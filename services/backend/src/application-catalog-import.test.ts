import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectApplicationCatalogFile } from './application-catalog-import.js'

test('application catalog maps singular and plural application headers', async () => {
  for (const header of ['application', 'application name', 'applications', 'application names']) {
    const directory = await mkdtemp(join(tmpdir(), 'application-catalog-'))
    const filePath = join(directory, 'applications.csv')
    try {
      await writeFile(filePath, `${header},Description\nBilling,Billing and invoicing\n`)
      const report = await inspectApplicationCatalogFile(filePath)
      assert.equal(report.rowCount, 1, header)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('application catalog maps singular and plural description headers', async () => {
  for (const header of ['application_description', 'description', 'descriptions', 'applicationdescription', 'applicationdescriptions']) {
    const directory = await mkdtemp(join(tmpdir(), 'application-catalog-'))
    const filePath = join(directory, 'applications.csv')
    try {
      await writeFile(filePath, `Application,${header}\nBilling,Billing and invoicing\n`)
      const report = await inspectApplicationCatalogFile(filePath)
      assert.equal(report.rowCount, 1, header)
      assert.doesNotMatch(report.warnings.join(' '), /Ignored unknown columns/, header)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('application catalog accepts application names and optional descriptions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'application-catalog-'))
  const filePath = join(directory, 'applications.csv')
  try {
    await writeFile(filePath, 'Application Name,Application Description\nBilling,Billing and invoicing\nClaims,\n')
    const report = await inspectApplicationCatalogFile(filePath)
    assert.equal(report.rowCount, 2)
    assert.match(report.warnings.join(' '), /Application Name -> APPLICATION/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('application catalog skips rows without an application name when valid rows remain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'application-catalog-'))
  const filePath = join(directory, 'applications.csv')
  try {
    await writeFile(filePath, 'Application,Description\nBilling,Billing application\n,Missing name\n')
    const report = await inspectApplicationCatalogFile(filePath)
    assert.equal(report.rowCount, 1)
    assert.match(report.warnings.join(' '), /Skipped 1 row without an APPLICATION value/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('application catalog rejects files containing no application names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'application-catalog-'))
  const filePath = join(directory, 'applications.csv')
  try {
    await writeFile(filePath, 'Application,Description\n,Missing name\n')
    await assert.rejects(inspectApplicationCatalogFile(filePath), /does not contain any rows with an APPLICATION value/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('application catalog accepts optional contact columns with spaced headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'application-catalog-'))
  const filePath = join(directory, 'applications.csv')
  try {
    await writeFile(filePath, 'Application,First Name,Last Name,Email Address\nBilling,Ada,Lovelace,ada@example.test\n')
    const report = await inspectApplicationCatalogFile(filePath)
    assert.equal(report.rowCount, 1)
    assert.doesNotMatch(report.warnings.join(' '), /Ignored unknown columns/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})