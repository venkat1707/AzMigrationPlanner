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

test('HLD Word document renders an SVG architecture diagram with clear summaries', async () => {
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
  const svgName = Object.keys(zip.files).find((name) => /^word\/media\/.*\.svg$/i.test(name))
  assert.ok(svgName, 'an SVG image should be embedded')
  const svg = await zip.file(svgName)!.async('string')

  assert.match(styles, /w:rFonts w:ascii="Aptos"[^>]+w:hAnsi="Aptos"/)
  assert.match(styles, /w:style w:type="paragraph" w:styleId="HldTitle"[\s\S]*?w:ascii="Aptos Display"[\s\S]*?<w:sz w:val="42"\/>/)
  assert.match(document, /DOCUMENT TITLE[\s\S]*Alex Architect[\s\S]*Cloud Review Board[\s\S]*0\.3/)
  assert.match(document, /Contents[\s\S]*Billing — Microsoft Azure high-level design/)
  assert.match(document, /w:leader="dot"/)
  assert.match(document, /Architecture Overview/)
  assert.match(document, /target design for [\s\S]*on Microsoft Azure/)
  assert.match(document, /Key connections/)
  assert.match(document, /application map for [\s\S]*includes/)
  assert.match(document, /Figure 1\./)
  assert.match(document, /<w:drawing>/)
  assert.doesNotMatch(document, /mermaid|flowchart LR|VM --&gt; DB|w:fldChar|w:instrText/i)
  // Diagram content lives in the embedded SVG image
  assert.match(svg, /Target Azure architecture/)
  assert.match(svg, /Connected systems and infrastructure/)
  assert.match(svg, /Application workload/)
  assert.match(svg, /Azure landing-zone placement/)
  assert.match(svg, /billing-01/)
  // Blue palette, not teal
  assert.match(`${styles}${document}`, /1F5FA6|14315C|2E6FBE/)
  assert.doesNotMatch(`${styles}${document}`, /0F6B78|0F7885|123F52|EDF5F5/)
  assert.match(relationships, /relationships\/footer/)
  assert.doesNotMatch(settings, /updateFields/)
  assert.match(footer, /CLOUD ACCELERATE FACTORY   ·   HLD 0\.3/)
  assert.doesNotMatch(footer, /w:fldChar|w:instrText|PAGE|NUMPAGES/)
  assert.match(core, /<dc:creator>Alex Architect<\/dc:creator>/)
})

test('HLD renders an agent-provided architecture diagram with zones and key connections', async () => {
  const diagram = {
    zones: [
      { name: 'Hub (Platform)', components: ['ExpressRoute', 'Azure Firewall Premium'] },
      { name: 'Spoke: vnet-migration-dev', components: ['snet-application', 'App VM', 'Oracle Database'] },
    ],
    flows: [{ from: 'App VM', to: 'Oracle Database', detail: '1521' }],
  }
  const bytes = Buffer.from(await buildDocx('Billing High-Level Design', '## Executive Summary\nPlain summary.', context, { author: 'Alex Architect', reviewers: ['Cloud Review Board'], version: '0.3' }, diagram), 'base64')
  const zip = await JSZip.loadAsync(bytes)
  const document = await zip.file('word/document.xml')!.async('string')
  const svgName = Object.keys(zip.files).find((name) => /^word\/media\/.*\.svg$/i.test(name))
  assert.ok(svgName)
  const svg = await zip.file(svgName)!.async('string')
  assert.match(svg, /Hub \(Platform\)/)
  assert.match(svg, /Azure Firewall Premium/)
  assert.match(svg, /Spoke: vnet-migration-dev/)
  assert.match(svg, /App VM/)
  assert.match(svg, /Oracle Database/)
  assert.match(document, /Key connections/)
  assert.match(document, /1521/)
  assert.doesNotMatch(svg, /billing-01/)
})
