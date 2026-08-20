import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { convertSplunkExportToCsvString } from './splunk-import.js'

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'splunk-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('converts a CIM Network Traffic export into canonical dependency rows, aggregating counts', async () => {
  await withTempDir(async (dir) => {
    const csvPath = path.join(dir, 'export.csv')
    const csv = [
      '_time,src,src_ip,dest,dest_ip,dest_port,transport,app,vendor_product',
      '2026-01-01T00:00:00.000-00:00,app01.corp.local,10.0.0.5,db01.corp.local,10.0.0.9,1521,tcp,mysql,Palo Alto Networks',
      '2026-01-01T00:00:01.000-00:00,app01.corp.local,10.0.0.5,db01.corp.local,10.0.0.9,1521,tcp,mysql,Palo Alto Networks',
      '2026-01-01T00:00:02.000-00:00,app01.corp.local,10.0.0.5,203.0.113.7,203.0.113.7,443,tcp,ssl,Palo Alto Networks',
    ].join('\n')
    await writeFile(csvPath, csv)
    const { csv: result, result: summary } = await convertSplunkExportToCsvString(csvPath, new Map())
    const lines = result.trim().split('\n')
    assert.equal(lines[0], 'Date,Source Appliance Name,Source Machine ARM ID,Source Server Name,Source IP,Source Application,Source Process,Destination Machine ARM ID,Destination Server Name,Destination IP,Destination Application,Destination Process,Destination Port,Connection Count,Protocol')
    assert.equal(summary.recordsRead, 3)
    assert.equal(summary.dependencyRows, 2)
    const aggregated = lines.find((line) => line.includes('db01.corp.local'))
    assert.ok(aggregated, 'the two flows to the database should aggregate into one row')
    assert.match(aggregated!, /,1521,2,tcp$/)
    assert.match(aggregated!, /Palo Alto Networks/)
    const external = lines.find((line) => line.includes('203.0.113.7'))
    assert.ok(external, 'a flow with no separate hostname falls back to the IP for both host and IP columns')
    assert.match(external!, /,443,1,tcp$/)
  })
})

test('resolves bare IP addresses to hostnames using a supplied DNS map', async () => {
  await withTempDir(async (dir) => {
    const csvPath = path.join(dir, 'export.csv')
    const csv = [
      'time,src_ip,dest_ip,dest_port,proto',
      '1735689600,10.0.0.5,10.0.0.9,1521,tcp',
    ].join('\n')
    await writeFile(csvPath, csv)
    const hostnameByIp = new Map([['10.0.0.5', 'app01.corp.local'], ['10.0.0.9', 'db01.corp.local']])
    const { csv: result } = await convertSplunkExportToCsvString(csvPath, hostnameByIp)
    assert.match(result, /app01\.corp\.local/)
    assert.match(result, /db01\.corp\.local/)
  })
})

test('falls back to numeric IANA protocol codes and vendor/sourcetype-derived appliance names', async () => {
  await withTempDir(async (dir) => {
    const csvPath = path.join(dir, 'export.csv')
    const csv = [
      '_time,srcaddr,dstaddr,dstport,protocol,sourcetype',
      '1735689600,10.0.0.5,10.0.0.9,443,6,aws:vpcflow',
    ].join('\n')
    await writeFile(csvPath, csv)
    const { csv: result, result: summary } = await convertSplunkExportToCsvString(csvPath, new Map())
    assert.equal(summary.dependencyRows, 1)
    assert.match(result.trim(), /,443,1,tcp$/)
    assert.match(result, /aws:vpcflow/)
  })
})

test('rejects an export missing both source and destination columns', async () => {
  await withTempDir(async (dir) => {
    const csvPath = path.join(dir, 'export.csv')
    await writeFile(csvPath, '_time,app\n1735689600,ssl\n')
    await assert.rejects(
      () => convertSplunkExportToCsvString(csvPath, new Map()),
      /must include a source .* and destination/,
    )
  })
})
