import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { convertConnLogToCsvString, hostnameMapFromDns, parseDnsRecords } from './corelight-import.js'

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'corelight-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

const jsonConn = [
  JSON.stringify({ ts: 1735689600, 'id.orig_h': '10.0.0.5', 'id.resp_h': '10.0.0.9', 'id.resp_p': 1521 }),
  JSON.stringify({ ts: 1735689601, 'id.orig_h': '10.0.0.5', 'id.resp_h': '10.0.0.9', 'id.resp_p': 1521 }),
  JSON.stringify({ ts: 1735689602, 'id.orig_h': '10.0.0.5', 'id.resp_h': '203.0.113.7', 'id.resp_p': 443 }),
].join('\n')

const jsonDns = [
  JSON.stringify({ ts: 1735689600, query: 'app01.corp.local', answers: ['10.0.0.5'] }),
  JSON.stringify({ ts: 1735689600, query: 'db01.corp.local', answers: ['10.0.0.9', 'not-an-ip'] }),
].join('\n')

test('parses DNS answers into unique query/IP records', async () => {
  await withTempDir(async (dir) => {
    const dnsPath = path.join(dir, 'dns.log')
    await writeFile(dnsPath, jsonDns)
    const records = await parseDnsRecords(dnsPath)
    assert.deepEqual(records.map((record) => `${record.query}|${record.ipAddress}`).sort(), [
      'app01.corp.local|10.0.0.5',
      'db01.corp.local|10.0.0.9',
    ])
  })
})

test('converts conn.log to canonical dependency rows, resolving hostnames and aggregating counts', async () => {
  await withTempDir(async (dir) => {
    const connPath = path.join(dir, 'conn.log')
    const dnsPath = path.join(dir, 'dns.log')
    await writeFile(connPath, jsonConn)
    await writeFile(dnsPath, jsonDns)
    const hostnameByIp = hostnameMapFromDns(await parseDnsRecords(dnsPath))
    const { csv, result } = await convertConnLogToCsvString(connPath, hostnameByIp, { appliance: 'Corelight' })
    const lines = csv.trim().split('\n')
    assert.equal(lines[0], 'Date,Source Appliance Name,Source Machine ARM ID,Source Server Name,Source IP,Source Application,Source Process,Destination Machine ARM ID,Destination Server Name,Destination IP,Destination Application,Destination Process,Destination Port,Connection Count')
    assert.equal(result.recordsRead, 3)
    assert.equal(result.dependencyRows, 2)
    const resolved = lines.find((line) => line.includes('app01.corp.local') && line.includes('db01.corp.local'))
    assert.ok(resolved, 'the two flows to the database should aggregate into one row')
    assert.match(resolved!, /,1521,2$/)
    const fallback = lines.find((line) => line.includes('203.0.113.7'))
    assert.ok(fallback, 'an unresolved destination should fall back to its IP')
    assert.equal(result.unresolvedHosts, 1)
  })
})

test('supports the classic Zeek TSV conn.log format', async () => {
  await withTempDir(async (dir) => {
    const connPath = path.join(dir, 'conn.log')
    const tsv = [
      '#separator \\x09',
      '#fields\tts\tid.orig_h\tid.orig_p\tid.resp_h\tid.resp_p\tproto',
      '1735689600\t10.0.0.5\t51000\t10.0.0.9\t1521\ttcp',
      '#close 2026-01-01-00-00-00',
    ].join('\n')
    await writeFile(connPath, tsv)
    const { csv, result } = await convertConnLogToCsvString(connPath, new Map(), { appliance: 'Zeek' })
    assert.equal(result.recordsRead, 1)
    assert.equal(result.dependencyRows, 1)
    assert.match(csv, /Zeek/)
    assert.match(csv, /10\.0\.0\.5/)
    assert.match(csv, /10\.0\.0\.9/)
  })
})
