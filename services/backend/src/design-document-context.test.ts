import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import sharp from 'sharp'
import { buildDocx, buildResponsesUrl, formatHldContextMessage } from './design-document.js'

const context = {
  application: 'Billing',
  environment: 'Production',
  platformLandingZone: { primaryRegion: 'eastus2', networkTopology: 'Hub and spoke' },
  applicationMap: { application: 'Billing', environment: 'Production', nodes: [{ id: 'server:billing-01', label: 'billing-01', local: true }, { id: 'application:crm', label: 'CRM' }], edges: [] },
  applicationTreatment: { application: 'Billing', environment: 'Production', treatmentPlan: 'Rehost', servers: ['billing-01'] },
  sprintToLandingZoneMappings: [{ serverName: 'billing-01', sprintSequence: 2, subscriptionName: 'Production', virtualNetwork: 'prod-vnet', subnet: 'app-subnet' }],
}

test('HLD agent message includes all application and environment scoped design inputs', () => {
  const message = formatHldContextMessage(context)
  assert.match(message, /^Task: Produce a design document\.\nHLD context \(JSON\):\n/)
  const payload = JSON.parse(message.split('\n').slice(2).join('\n'))
  assert.deepEqual(payload, context)
  assert.equal(payload.applicationMap.application, 'Billing')
  assert.equal(payload.applicationTreatment.environment, 'Production')
  assert.equal(payload.sprintToLandingZoneMappings.length, 1)
  assert.equal(payload.sprintToLandingZoneMappings[0]!.serverName, 'billing-01')
})

test('Foundry request uses the stable published endpoint without pinning an agent version', () => {
  const endpoint = 'https://example.services.ai.azure.com/api/projects/project/agents/MigrationPlannerAgent/endpoint/protocols/openai/responses'
  const requestUrl = new URL(buildResponsesUrl(endpoint))
  assert.equal(requestUrl.pathname, '/api/projects/project/agents/MigrationPlannerAgent/endpoint/protocols/openai/responses')
  assert.equal(requestUrl.searchParams.get('api-version'), 'v1')
  assert.doesNotMatch(requestUrl.pathname, /\/versions?\//i)
})

test('HLD Word document uses a restrained title and embeds the architecture diagram', async () => {
  const bytes = Buffer.from(await buildDocx('Billing High-Level Design', '## Executive Summary\nDesign summary.', context, { author: 'Alex Architect', reviewers: ['Cloud Review Board'], version: '0.3' }), 'base64')
  assert.equal(bytes.subarray(0, 2).toString(), 'PK')
  const zip = await JSZip.loadAsync(bytes)
  const styles = await zip.file('word/styles.xml')!.async('string')
  const document = await zip.file('word/document.xml')!.async('string')
  const relationships = await zip.file('word/_rels/document.xml.rels')!.async('string')
  const settings = await zip.file('word/settings.xml')!.async('string')
  const footer = await zip.file('word/footer1.xml')!.async('string')
  const core = await zip.file('docProps/core.xml')!.async('string')
  const imageFile = Object.keys(zip.files).find((name) => /^word\/media\/.*\.png$/i.test(name))
  assert.ok(imageFile)
  const image = await zip.file(imageFile)!.async('nodebuffer')
  const metadata = await sharp(image).metadata()

  assert.match(styles, /w:style w:type="paragraph" w:styleId="HldTitle"[\s\S]*?<w:sz w:val="40"\/>/)
  assert.match(document, /Document title[\s\S]*Alex Architect[\s\S]*Cloud Review Board[\s\S]*0\.3/)
  assert.match(document, /TOC \\h \\o &quot;1-3&quot;/)
  assert.match(document, /w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Executive Summary/)
  assert.match(document, /<w:drawing>/)
  assert.match(relationships, new RegExp(`relationships/image[^>]+media/${imageFile.split('/').pop()!.replace('.', '\\.')}`))
  assert.match(relationships, /relationships\/footer/)
  assert.match(settings, /<w:updateFields\/>/)
  assert.match(footer, /Version 0\.3 · Page [\s\S]*>PAGE<[\s\S]*>NUMPAGES</)
  assert.match(core, /<dc:creator>Alex Architect<\/dc:creator>/)
  assert.equal(metadata.width, 1200)
  assert.equal(metadata.height, 675)
  assert.ok(image.byteLength > 10_000)
})
