import { basename } from 'node:path'

export type WindowsServiceReference = {
  windowsService: string
  shortDescription: string
  ports: string
  networkProtocol: string
  applicationProtocol: string
}

export type WindowsServiceCorrelation = {
  reference: WindowsServiceReference
  matchMethod: 'process_and_port' | 'port_only'
}

function normalizedName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
}

function processName(value: string): string {
  return normalizedName(basename(value.replaceAll('\\', '/')).replace(/\.(exe|dll|com)$/i, ''))
}

function serviceAliases(value: string): string[] {
  const baseName = value.replaceAll(/\s*\([^)]*\)/g, '').trim()
  const parentheticalNames = [...value.matchAll(/\(([^)]+)\)/g)].map((match) => match[1] ?? '')
  return [baseName, ...parentheticalNames].map(normalizedName).filter(Boolean)
}

function includesPort(ports: string, port: number): boolean {
  return ports.split(',').some((entry) => {
    const value = entry.trim()
    const range = value.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) return port >= Number(range[1]) && port <= Number(range[2])
    return /^\d+$/.test(value) && Number(value) === port
  })
}

export function findWindowsServiceReferences(process: string | null, port: number | null, references: WindowsServiceReference[]): WindowsServiceCorrelation[] {
  if (!process || port === null) return []
  const observedProcess = processName(process)
  if (!observedProcess) return []
  if (observedProcess === 'svchost') {
    return references
      .filter((reference) => includesPort(reference.ports, port))
      .map((reference) => ({ reference, matchMethod: 'port_only' }))
  }
  const reference = references.find((candidate) => serviceAliases(candidate.windowsService).includes(observedProcess) && includesPort(candidate.ports, port))
  return reference ? [{ reference, matchMethod: 'process_and_port' }] : []
}