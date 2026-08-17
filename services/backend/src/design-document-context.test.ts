import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import sharp from 'sharp'
import { buildDocx, formatHldContextMessage } from './design-document.js'

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

test('HLD Word document uses a restrained title and embeds the architecture diagram', async () => {
  const zip = await JSZip.loadAsync(Buffer.from(await buildDocx('Billing High-Level Design', '## Executive Summary\nDesign summary.', context), 'base64'))
  const styles = await zip.file('word/styles.xml')!.async('string')
  const document = await zip.file('word/document.xml')!.async('string')
  const relationships = await zip.file('word/_rels/document.xml.rels')!.async('string')
  const image = await zip.file('word/media/architecture.png')!.async('nodebuffer')
  const metadata = await sharp(image).metadata()

  assert.match(styles, /w:style w:type="paragraph" w:styleId="Title"[\s\S]*?<w:sz w:val="40"\/>/)
  assert.match(document, /r:embed="rId3"/)
  assert.match(relationships, /Id="rId3"[^>]+relationships\/image[^>]+media\/architecture\.png/)
  assert.equal(metadata.width, 1200)
  assert.equal(metadata.height, 675)
  assert.ok(image.byteLength > 10_000)
})
