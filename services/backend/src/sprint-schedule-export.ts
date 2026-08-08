import { createRequire } from 'node:module'
import ExcelJS from 'exceljs'

type PresentationSlide = {
  background: { color: string }
  addText: (text: string, options: Record<string, unknown>) => void
  addShape: (shape: unknown, options: Record<string, unknown>) => void
}

type Presentation = {
  layout: string
  author: string
  company: string
  subject: string
  title: string
  theme: Record<string, unknown>
  ShapeType: { line: unknown; roundRect: unknown }
  addSlide: () => PresentationSlide
  write: (options: Record<string, unknown>) => Promise<string | ArrayBuffer | Blob | Uint8Array>
}

const PptxGenJS = createRequire(import.meta.url)('pptxgenjs') as new () => Presentation

export type ScheduleAssessment = {
  serverName: string
  application: string | null
  environment: string | null
}

export type SchedulePlan = {
  waves: Array<{
    wave: number
    environment: string
    sprints: Array<{
      sequence: number
      sprint: number
      name: string
      serverCount: number
      targetedStartDate?: string
      targetedEndDate?: string
      servers: Array<{ name: string; application: string; environment: string }>
    }>
  }>
}

export type SprintScheduleView = {
  waves: Array<{
    wave: number
    environment: string
    sprints: Array<{
      sequence: number
      sprint: number
      name: string
      serverCount: number
      applications: string[]
      targetedStartDate: string | null
      targetedEndDate: string | null
    }>
  }>
  serverTimeline: Array<{
    serverName: string
    application: string | null
    environment: string | null
    wave: number | null
    sprintSequence: number | null
    sprintName: string | null
    targetedStartDate: string | null
    targetedEndDate: string | null
  }>
}

const millisecondsPerDay = 86_400_000
const waveColors = ['8B4A6F', '087F8C', '2563EB', '7C5C20']

function dateValue(value: string): number {
  return new Date(`${value}T00:00:00.000Z`).getTime()
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function buildSprintScheduleView(plan: SchedulePlan, assessedServers: ScheduleAssessment[]): SprintScheduleView {
  const assignments = new Map(plan.waves.flatMap((wave) => wave.sprints.flatMap((sprint) => sprint.servers.map((server) => [server.name.trim().toLowerCase(), {
    wave: wave.wave,
    environment: wave.environment,
    sprintSequence: sprint.sequence,
    sprintName: sprint.name,
    targetedStartDate: sprint.targetedStartDate ?? null,
    targetedEndDate: sprint.targetedEndDate ?? null,
  }] as const))))

  return {
    waves: plan.waves.map((wave) => ({
      wave: wave.wave,
      environment: wave.environment,
      sprints: wave.sprints.map((sprint) => ({
        sequence: sprint.sequence,
        sprint: sprint.sprint,
        name: sprint.name,
        serverCount: sprint.serverCount,
        applications: [...new Set(sprint.servers.map(({ application }) => application).filter(Boolean))].sort(),
        targetedStartDate: sprint.targetedStartDate ?? null,
        targetedEndDate: sprint.targetedEndDate ?? null,
      })),
    })),
    serverTimeline: assessedServers.map((server) => ({
      ...server,
      ...(assignments.get(server.serverName.trim().toLowerCase()) ?? {
        wave: null,
        sprintSequence: null,
        sprintName: null,
        targetedStartDate: null,
        targetedEndDate: null,
      }),
    })),
  }
}

function scheduledSprints(view: SprintScheduleView) {
  return view.waves.flatMap((wave) => wave.sprints.flatMap((sprint) => sprint.targetedStartDate ? [{
    ...sprint,
    wave: wave.wave,
    environment: wave.environment,
    start: sprint.targetedStartDate,
    end: sprint.targetedEndDate ?? addDays(sprint.targetedStartDate, 21),
  }] : []))
}

function styleHeader(row: ExcelJS.Row) {
  row.height = 22
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF25476F' } }
  row.alignment = { vertical: 'middle' }
}

function fitColumns(sheet: ExcelJS.Worksheet, maximum = 52) {
  for (const column of sheet.columns) {
    let width = 10
    column.eachCell?.({ includeEmpty: false }, (cell) => { width = Math.max(width, String(cell.value ?? '').length + 2) })
    column.width = Math.min(maximum, width)
  }
}

export async function createSprintScheduleWorkbook(view: SprintScheduleView): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Cloud Accelerate Factory'
  workbook.created = new Date()

  const summary = workbook.addWorksheet('Sprint Summary', { views: [{ state: 'frozen', ySplit: 1 }] })
  summary.columns = [
    { header: 'Wave', key: 'wave' }, { header: 'Environment', key: 'environment' }, { header: 'Sprint', key: 'sprint' },
    { header: 'Sequence', key: 'sequence' }, { header: 'Targeted Start', key: 'start' }, { header: 'Targeted End', key: 'end' },
    { header: 'Duration Days', key: 'duration' }, { header: 'Servers', key: 'servers' }, { header: 'Applications', key: 'applicationCount' },
    { header: 'Application Summary', key: 'applications' },
  ]
  for (const wave of view.waves) for (const sprint of wave.sprints) summary.addRow({
    wave: wave.wave,
    environment: wave.environment,
    sprint: sprint.name,
    sequence: sprint.sequence,
    start: sprint.targetedStartDate,
    end: sprint.targetedEndDate,
    duration: sprint.targetedStartDate && sprint.targetedEndDate ? Math.round((dateValue(sprint.targetedEndDate) - dateValue(sprint.targetedStartDate)) / millisecondsPerDay) : null,
    servers: sprint.serverCount,
    applicationCount: sprint.applications.length,
    applications: sprint.applications.join(' | '),
  })
  styleHeader(summary.getRow(1))
  summary.autoFilter = { from: 'A1', to: 'J1' }
  fitColumns(summary)

  const serverSheet = workbook.addWorksheet('Server Timeline', { views: [{ state: 'frozen', ySplit: 1 }] })
  serverSheet.columns = [
    { header: 'Server', key: 'serverName' }, { header: 'Application', key: 'application' }, { header: 'Assessment Environment', key: 'assessmentEnvironment' },
    { header: 'Wave', key: 'wave' }, { header: 'Sprint Sequence', key: 'sprintSequence' }, { header: 'Sprint', key: 'sprintName' },
    { header: 'Targeted Start', key: 'targetedStartDate' }, { header: 'Targeted End', key: 'targetedEndDate' }, { header: 'Assignment Status', key: 'status' },
  ]
  for (const server of view.serverTimeline) serverSheet.addRow({
    ...server,
    assessmentEnvironment: server.environment,
    status: server.sprintSequence === null ? 'Not assigned to a saved sprint' : 'Assigned',
  })
  styleHeader(serverSheet.getRow(1))
  serverSheet.autoFilter = { from: 'A1', to: 'I1' }
  fitColumns(serverSheet)

  const sprints = scheduledSprints(view)
  const gantt = workbook.addWorksheet('Sprint Gantt', { views: [{ state: 'frozen', xSplit: 4, ySplit: 1 }] })
  if (sprints.length === 0) {
    gantt.addRow(['No scheduled sprints. Add targeted start dates in the Sprint Schedule workspace.'])
  } else {
    const minimum = Math.min(...sprints.map(({ start }) => dateValue(start)))
    const maximum = Math.max(...sprints.map(({ end }) => dateValue(end)))
    const weeks = Array.from({ length: Math.ceil((maximum - minimum) / millisecondsPerDay / 7) + 1 }, (_, index) => minimum + index * 7 * millisecondsPerDay)
    gantt.addRow(['Wave / Environment', 'Sprint', 'Applications', 'Servers', ...weeks.map((week) => new Date(week).toISOString().slice(0, 10))])
    styleHeader(gantt.getRow(1))
    for (const sprint of sprints) {
      const row = gantt.addRow([`Wave ${sprint.wave} / ${sprint.environment}`, sprint.name, sprint.applications.join(' | '), sprint.serverCount])
      row.height = 30
      const color = waveColors[sprint.wave % waveColors.length]!
      weeks.forEach((week, index) => {
        const weekEnd = week + 6 * millisecondsPerDay
        if (week <= dateValue(sprint.end) && weekEnd >= dateValue(sprint.start)) {
          const cell = row.getCell(index + 5)
          cell.value = sprint.name
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${color}` } }
          cell.font = { color: { argb: 'FFFFFFFF' }, size: 9 }
        }
      })
    }
    gantt.getColumn(1).width = 22
    gantt.getColumn(2).width = 16
    gantt.getColumn(3).width = 48
    gantt.getColumn(4).width = 10
    for (let index = 5; index <= gantt.columnCount; index += 1) gantt.getColumn(index).width = 13
  }

  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function createSprintSchedulePresentation(view: SprintScheduleView): Promise<Buffer> {
  const presentation = new PptxGenJS()
  presentation.layout = 'LAYOUT_WIDE'
  presentation.author = 'Cloud Accelerate Factory'
  presentation.company = 'Microsoft'
  presentation.subject = 'Migration sprint schedule'
  presentation.title = 'Migration Sprint Timeline'
  presentation.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'en-US' }

  const sprints = scheduledSprints(view)
  if (sprints.length === 0) {
    const slide = presentation.addSlide()
    slide.background = { color: 'F4F7FB' }
    slide.addText('Migration Sprint Timeline', { x: 0.7, y: 0.65, w: 11.9, h: 0.45, fontFace: 'Aptos Display', fontSize: 24, bold: true, color: '172033' })
    slide.addText('No scheduled sprints. Add targeted start dates in the Sprint Schedule workspace.', { x: 0.7, y: 1.45, w: 11.9, h: 0.4, fontSize: 14, color: '526176' })
  } else {
    const minimum = Math.min(...sprints.map(({ start }) => dateValue(start)))
    const maximum = Math.max(...sprints.map(({ end }) => dateValue(end)))
    const totalDays = Math.max(1, Math.round((maximum - minimum) / millisecondsPerDay) + 1)
    const pages = Array.from({ length: Math.ceil(sprints.length / 6) }, (_, index) => sprints.slice(index * 6, index * 6 + 6))
    for (const [pageIndex, pageSprints] of pages.entries()) {
      const slide = presentation.addSlide()
      slide.background = { color: 'F8FAFD' }
      slide.addText('Migration Sprint Timeline', { x: 0.55, y: 0.35, w: 8.4, h: 0.4, fontFace: 'Aptos Display', fontSize: 23, bold: true, color: '172033' })
      slide.addText(`${new Date(minimum).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${new Date(maximum).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`, { x: 9.8, y: 0.42, w: 2.9, h: 0.25, align: 'right', fontSize: 10, color: '526176' })
      slide.addText('Sprint summary', { x: 0.55, y: 1.02, w: 2.25, h: 0.25, fontSize: 9, bold: true, color: '526176' })
      slide.addText('Timeline', { x: 3.05, y: 1.02, w: 9.3, h: 0.25, fontSize: 9, bold: true, color: '526176' })
      const tickCount = 7
      for (let index = 0; index < tickCount; index += 1) {
        const tick = minimum + Math.round((totalDays - 1) * index / (tickCount - 1)) * millisecondsPerDay
        const x = 3.05 + (9.3 * index / (tickCount - 1))
        slide.addText(new Date(tick).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), { x: x - 0.35, y: 1.02, w: 0.7, h: 0.25, align: 'center', fontSize: 8, color: '65758A' })
        slide.addShape(presentation.ShapeType.line, { x, y: 1.34, w: 0, h: 5.7, line: { color: 'E3E9F1', width: 1 } })
      }
      pageSprints.forEach((sprint, index) => {
        const y = 1.48 + index * 0.88
        const left = 3.05 + ((dateValue(sprint.start) - minimum) / millisecondsPerDay / totalDays) * 9.3
        const width = Math.max(0.62, (((dateValue(sprint.end) - dateValue(sprint.start)) / millisecondsPerDay) + 1) / totalDays * 9.3)
        const color = waveColors[sprint.wave % waveColors.length]!
        const applicationSummary = sprint.applications.length === 0
          ? 'No applications mapped'
          : `${sprint.applications.slice(0, 2).join(', ')}${sprint.applications.length > 2 ? ` +${sprint.applications.length - 2}` : ''}`
        slide.addText(`Wave ${sprint.wave}  |  ${sprint.name}`, { x: 0.55, y, w: 2.25, h: 0.24, fontSize: 11, bold: true, color: '253A52', margin: 0 })
        slide.addText(`${sprint.environment}  |  ${sprint.applications.length} application${sprint.applications.length === 1 ? '' : 's'}`, { x: 0.55, y: y + 0.27, w: 2.25, h: 0.2, fontSize: 8, color: '526176', margin: 0 })
        slide.addText(applicationSummary, { x: 0.55, y: y + 0.5, w: 2.25, h: 0.22, fontSize: 7.5, color: '7B899D', margin: 0, fit: 'shrink' })
        slide.addShape(presentation.ShapeType.roundRect, { x: left, y: y + 0.08, w: width, h: 0.58, rectRadius: 0.04, fill: { color }, line: { color }, shadow: { type: 'outer', color: '94A3B8', opacity: 0.18, blur: 1, angle: 45, distance: 1 } })
        slide.addText(`${sprint.name}\n${sprint.serverCount} server${sprint.serverCount === 1 ? '' : 's'}`, { x: left + 0.08, y: y + 0.16, w: Math.max(0.38, width - 0.16), h: 0.38, fontSize: 9, bold: true, color: 'FFFFFF', align: 'center', valign: 'mid', margin: 0, fit: 'shrink' })
      })
      slide.addText(`Page ${pageIndex + 1} of ${pages.length} · Generated from the saved migration wave plan`, { x: 0.55, y: 7.08, w: 12.2, h: 0.18, fontSize: 7, color: '7B899D' })
    }
  }

  const output = await presentation.write({ outputType: 'nodebuffer', compression: true })
  return Buffer.isBuffer(output) ? output : Buffer.from(output as Uint8Array)
}
