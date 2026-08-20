import assert from 'node:assert/strict'
import test from 'node:test'
import knex from 'knex'
import { createTreatmentPlanMerge } from './application-treatment-plans.js'

test('treatment plan bulk upsert updates only treatment metadata', () => {
  const queryBuilder = knex({ client: 'mysql2' })
  try {
    const transaction = queryBuilder as unknown as import('knex').Knex.Transaction
    const compiled = queryBuilder('applications')
      .insert([{ name: 'Billing', treatment_plan: 'Rehost' }, { name: 'Claims', treatment_plan: 'Retire' }])
      .onConflict('name')
      .merge(createTreatmentPlanMerge(transaction))
      .toSQL()
    assert.match(compiled.sql, /on duplicate key update `treatment_plan` = VALUES\(`treatment_plan`\),`updated_at` = CURRENT_TIMESTAMP/)
    assert.doesNotMatch(compiled.sql, /`description` = VALUES/)
    assert.doesNotMatch(compiled.sql, /`source` = VALUES/)
  } finally {
    void queryBuilder.destroy()
  }
})