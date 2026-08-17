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
  const markdown = '## Executive Summary\nDesign summary.\n## Target Azure Architecture\n```mermaid\nflowchart LR\n  VM --> DB\n```\nArchitecture narrative.'
  const bytes = Buffer.from(await buildDocx('Billing High-Level Design', markdown, context, { author: 'Alex Architect', reviewers: ['Cloud Review Board'], version: '0.3' }), 'base64')
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

  assert.match(styles, /w:rFonts w:ascii="Aptos"[^>]+w:hAnsi="Aptos"/)
  assert.match(styles, /w:style w:type="paragraph" w:styleId="HldTitle"[\s\S]*?w:ascii="Aptos Display"[\s\S]*?<w:sz w:val="42"\/>/)
  assert.match(document, /DOCUMENT TITLE[\s\S]*Alex Architect[\s\S]*Cloud Review Board[\s\S]*0\.3/)
  assert.match(document, /Contents[\s\S]*Document structure and design topics[\s\S]*Architecture Overview[\s\S]*Executive Summary[\s\S]*Target Azure Architecture/)
  assert.match(document, /<w:shd w:fill="0F6B78"/)
  assert.match(document, /<w:t xml:space="preserve">01<\/w:t>/)
  assert.match(document, /w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Executive Summary/)
  assert.doesNotMatch(document, /mermaid|flowchart LR|VM --&gt; DB|w:fldChar|w:instrText/i)
  assert.match(document, /<w:drawing>/)
  assert.match(relationships, new RegExp(`relationships/image[^>]+media/${imageFile.split('/').pop()!.replace('.', '\\.')}`))
  assert.match(relationships, /relationships\/footer/)
  assert.doesNotMatch(settings, /updateFields/)
  assert.match(footer, /CLOUD ACCELERATE FACTORY   ·   HLD 0\.3/)
  assert.doesNotMatch(footer, /w:fldChar|w:instrText|PAGE|NUMPAGES/)
  assert.match(core, /<dc:creator>Alex Architect<\/dc:creator>/)
  assert.equal(metadata.width, 1000)
  assert.equal(metadata.height, 1050)
  assert.ok(image.byteLength > 10_000)
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const darkPixels = (left: number, top: number, right: number, bottom: number) => {
    let count = 0
    for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
      const offset = (y * info.width + x) * info.channels
      if ((data[offset] ?? 255) < 120 && (data[offset + 1] ?? 255) < 140 && (data[offset + 2] ?? 255) < 160) count += 1
    }
    return count
  }
  assert.ok(darkPixels(55, 35, 800, 105) > 500, 'architecture title and platform labels must be visible')
  assert.ok(darkPixels(55, 150, 700, 190) > 250, 'architecture section heading must be visible')
})
