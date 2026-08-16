import type { Knex } from 'knex'

export type ApplicationTreatmentPlanUpdate = { name: string; treatmentPlan: string }

export function createTreatmentPlanMerge(transaction: Knex.Transaction): Record<string, Knex.Raw> {
  return {
    treatment_plan: transaction.raw('VALUES(??)', ['treatment_plan']),
    updated_at: transaction.fn.now(),
  }
}

export async function saveApplicationTreatmentPlans(
  connection: Knex,
  items: ApplicationTreatmentPlanUpdate[],
): Promise<number> {
  if (items.length === 0) return 0
  await connection.transaction(async (transaction) => {
    const names = items.map(({ name }) => name)
    const existingNames = new Set((await transaction('applications').whereIn('name', names).forUpdate().pluck('name')) as string[])
    if (existingNames.size !== items.length) throw new Error('One or more applications no longer exist.')
    await transaction('applications')
      .insert(items.map(({ name, treatmentPlan }) => ({ name, treatment_plan: treatmentPlan })))
      .onConflict('name')
      .merge(createTreatmentPlanMerge(transaction))
  })
  return items.length
}