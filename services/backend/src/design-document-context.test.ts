import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
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

test('HLD Word document renders a modern themed native architecture diagram', async () => {
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

  assert.match(styles, /w:rFonts w:ascii="Aptos"[^>]+w:hAnsi="Aptos"/)
  assert.match(styles, /w:style w:type="paragraph" w:styleId="HldTitle"[\s\S]*?w:ascii="Aptos Display"[\s\S]*?<w:sz w:val="42"\/>/)
  assert.match(document, /DOCUMENT TITLE[\s\S]*Alex Architect[\s\S]*Cloud Review Board[\s\S]*0\.3/)
  assert.match(document, /Microsoft Azure target-state architecture/)
  // Book-style contents: numbered entries, dot leaders, page numbers
  assert.match(document, /Contents[\s\S]*Billing — Microsoft Azure high-level design/)
  assert.match(document, /w:leader="dot"/)
  assert.match(document, /Architecture Overview[\s\S]*Executive Summary[\s\S]*Target Azure Architecture/)
  assert.doesNotMatch(document, /mermaid|flowchart LR|VM --&gt; DB|w:fldChar|w:instrText/i)
  // Native architecture diagram content and flow
  assert.match(document, /Connected systems and infrastructure/)
  assert.match(document, /Application workload/)
  assert.match(document, /Azure landing-zone placement/)
  assert.match(document, /billing-01/)
  assert.match(document, /\u25bc/)
  assert.match(document, /Figure 1\. Flow from connected systems/)
  // Blue palette, not teal
  assert.match(`${styles}${document}`, /1F5FA6|14315C|2E6FBE/)
  assert.doesNotMatch(`${styles}${document}`, /0F6B78|0F7885|123F52|EDF5F5/)
  assert.match(relationships, /relationships\/footer/)
  assert.doesNotMatch(settings, /updateFields/)
  assert.match(footer, /CLOUD ACCELERATE FACTORY   ·   HLD 0\.3/)
  assert.doesNotMatch(footer, /w:fldChar|w:instrText|PAGE|NUMPAGES/)
  assert.match(core, /<dc:creator>Alex Architect<\/dc:creator>/)
})
