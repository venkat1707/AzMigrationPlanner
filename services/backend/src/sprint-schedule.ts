export const sprintStatuses = ['Scheduled', 'In Progress', 'At Risk', 'Blocked', 'Closed'] as const
export type SprintStatus = typeof sprintStatuses[number]

export type SprintScheduleInput = {
  sequence: number
  targetedStartDate: string
  targetedEndDate?: string | null
  status?: string | null
}

export type SprintSchedule = {
  sequence: number
  targetedStartDate: string
  targetedEndDate: string
  status: SprintStatus
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

function parseIsoDate(value: string, field: string): Date {
  if (!isoDatePattern.test(value)) throw new Error(`${field} must use YYYY-MM-DD format.`)
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid calendar date.`)
  }
  return date
}

export function addDays(value: string, days: number): string {
  const date = parseIsoDate(value, 'Targeted start date')
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function normalizeSprintSchedule(input: SprintScheduleInput): SprintSchedule {
  if (!Number.isInteger(input.sequence) || input.sequence <= 0) throw new Error('Sprint sequence must be a positive integer.')
  const targetedStartDate = String(input.targetedStartDate ?? '').trim()
  const start = parseIsoDate(targetedStartDate, 'Targeted start date')
  const targetedEndDate = String(input.targetedEndDate ?? '').trim() || addDays(targetedStartDate, 21)
  const end = parseIsoDate(targetedEndDate, 'Targeted end date')
  if (end < start) throw new Error('Targeted end date cannot be before the targeted start date.')
  const status = String(input.status ?? '').trim() || 'Scheduled'
  if (!sprintStatuses.includes(status as SprintStatus)) throw new Error('Sprint status is not valid.')
  return { sequence: input.sequence, targetedStartDate, targetedEndDate, status: status as SprintStatus }
}