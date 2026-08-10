import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnvironment } from 'dotenv'
import type { Knex } from 'knex'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
loadEnvironment({ path: resolve(moduleDirectory, '../../../.env') })

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export function getDatabaseConfig(): Knex.Config {
  const sslEnabled = process.env.MYSQL_SSL !== 'false'
  return {
    client: 'mysql2',
    connection: () => ({
      host: required('MYSQL_HOST'),
      database: required('MYSQL_DATABASE'),
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: required('MYSQL_USER'),
      password: required('MYSQL_PASSWORD'),
      ssl: sslEnabled ? { rejectUnauthorized: true } : undefined,
      connectTimeout: 30_000,
    }),
    pool: { min: 0, max: 10, idleTimeoutMillis: 30_000 },
    acquireConnectionTimeout: 30_000,
  }
}

// On Windows/iisnode PORT is a named pipe string, so keep it unparsed there.
export const port: string | number = process.env.PORT ?? 3000