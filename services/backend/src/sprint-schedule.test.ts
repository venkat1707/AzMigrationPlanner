import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { addDays, normalizeSprintSchedule } from './sprint-schedule.js'
import { buildSprintScheduleView, createSprintSchedulePresentation, createSprintScheduleWorkbook, type SchedulePlan } from './sprint-schedule-export.js'

function schedulePlan(): SchedulePlan {
  return { waves: [
    { wave: 1, environment: 'Dev', sprints: [{ sequence: 1, sprint: 1, name: 'Sprint 1', serverCount: 1, targetedStartDate: '2026-08-03', targetedEndDate: '2026-08-24', servers: [{ name: 'APP-01', application: 'Billing', environment: 'Dev' }] }] },
    { wave: 2, environment: 'Test', sprints: [{ sequence: 2, sprint: 1, name: 'Sprint 2', serverCount: 0, targetedStartDate: '2026-09-01', targetedEndDate: '2026-09-22', servers: [] }] },
  ] }
}

test('sprint schedules default to three weeks when the end date is omitted', () => {
  assert.deepEqual(normalizeSprintSchedule({ sequence: 7, targetedStartDate: '2026-08-10' }), {
    sequence: 7,
    targetedStartDate: '2026-08-10',
    targetedEndDate: '2026-08-31',
    status: 'Scheduled',
  })
})

test('sprint schedules accept a valid status and reject an invalid one', () => {
  assert.equal(normalizeSprintSchedule({ sequence: 3, targetedStartDate: '2026-08-10', status: 'At Risk' }).status, 'At Risk')
  assert.throws(() => normalizeSprintSchedule({ sequence: 3, targetedStartDate: '2026-08-10', status: 'Unknown' }), /status is not valid/)
})

test('three-week defaults cross month and year boundaries', () => {
  assert.equal(addDays('2026-12-20', 21), '2027-01-10')
})

test('sprint schedules preserve an explicit valid end date', () => {
  assert.equal(normalizeSprintSchedule({
    sequence: 2,
    targetedStartDate: '2026-09-01',
    targetedEndDate: '2026-09-12',
  }).targetedEndDate, '2026-09-12')
})

test('sprint schedules reject invalid ranges and calendar dates', () => {
  assert.throws(() => normalizeSprintSchedule({
    sequence: 2,
    targetedStartDate: '2026-09-10',
    targetedEndDate: '2026-09-09',
  }), /cannot be before/)
  assert.throws(() => normalizeSprintSchedule({ sequence: 2, targetedStartDate: '2026-02-30' }), /valid calendar date/)
})

test('server timelines include every assessed server and follow current sprint assignments', () => {
  const plan = schedulePlan()
  const assessed = [
    { serverName: 'APP-01', application: 'Billing', environment: 'Dev' },
    { serverName: 'UNPLANNED-01', application: 'Archive', environment: 'Prod' },
  ]
  const initial = buildSprintScheduleView(plan, assessed)
  assert.equal(initial.serverTimeline.length, 2)
  assert.deepEqual(initial.serverTimeline[0], {
    serverName: 'APP-01', application: 'Billing', environment: 'Dev', wave: 1, sprintSequence: 1,
    sprintName: 'Sprint 1', targetedStartDate: '2026-08-03', targetedEndDate: '2026-08-24',
  })
  assert.equal(initial.serverTimeline[1]?.sprintSequence, null)

  const server = plan.waves[0]!.sprints[0]!.servers.pop()!
  plan.waves[1]!.sprints[0]!.servers.push(server)
  const moved = buildSprintScheduleView(plan, assessed)
  assert.equal(moved.serverTimeline[0]?.sprintSequence, 2)
  assert.equal(moved.serverTimeline[0]?.targetedStartDate, '2026-09-01')
  assert.deepEqual(moved.waves[1]?.sprints[0]?.applications, ['Billing'])
})

test('schedule exports generate Excel sheets and a PowerPoint archive', async () => {
  const view = buildSprintScheduleView(schedulePlan(), [{ serverName: 'APP-01', application: 'Billing', environment: 'Dev' }])
  const excel = await createSprintScheduleWorkbook(view)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(excel.buffer.slice(excel.byteOffset, excel.byteOffset + excel.byteLength) as ArrayBuffer)
  assert.deepEqual(workbook.worksheets.map(({ name }) => name), ['Sprint Summary', 'Server Timeline', 'Sprint Gantt'])
  assert.equal(workbook.getWorksheet('Server Timeline')?.rowCount, 2)

  const powerpoint = await createSprintSchedulePresentation(view)
  assert.equal(powerpoint.subarray(0, 2).toString(), 'PK')
  const archive = await JSZip.loadAsync(powerpoint)
  const slideXml = await archive.file('ppt/slides/slide1.xml')!.async('string')
  assert.match(slideXml, /1 server/)
  assert.match(slideXml, /1 application/)
  assert.match(slideXml, /Billing/)
})