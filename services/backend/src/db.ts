import knex from 'knex'
import { getDatabaseConfig } from './config.js'

export const database = knex(getDatabaseConfig())

export async function closeDatabase(): Promise<void> {
  await database.destroy()
}