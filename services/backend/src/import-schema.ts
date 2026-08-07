export type HeaderContract<Header extends string> = {
  headers: readonly Header[]
  required: ReadonlySet<Header>
  aliases?: Readonly<Record<string, Header>>
  optionalDefaults?: Readonly<Partial<Record<Header, string>>>
  formatName: string
}

export type HeaderMapping<Header extends string> = {
  sourceHeaders: string[]
  canonicalByIndex: Array<Header | null>
  warnings: string[]
}

export function normalizeImportHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function createHeaderMapping<Header extends string>(
  sourceHeaders: string[],
  contract: HeaderContract<Header>,
): HeaderMapping<Header> {
  const canonicalByNormalized = new Map(contract.headers.map((header) => [normalizeImportHeader(header), header]))
  for (const [alias, header] of Object.entries(contract.aliases ?? {})) {
    canonicalByNormalized.set(normalizeImportHeader(alias), header)
  }

  const canonicalByIndex: Array<Header | null> = []
  const sourceByCanonical = new Map<Header, string>()
  const unknown: string[] = []
  const aliasesUsed: string[] = []

  sourceHeaders.forEach((rawHeader, index) => {
    const sourceHeader = rawHeader.replace(/^\uFEFF/, '').trim()
    const normalized = normalizeImportHeader(sourceHeader)
    if (!normalized) throw new Error(`${contract.formatName} contains an empty header at column ${index + 1}.`)
    const canonical = canonicalByNormalized.get(normalized) ?? null
    canonicalByIndex.push(canonical)
    if (!canonical) {
      unknown.push(sourceHeader)
      return
    }
    const previous = sourceByCanonical.get(canonical)
    if (previous) {
      throw new Error(`${contract.formatName} maps both "${previous}" and "${sourceHeader}" to "${canonical}". Remove the duplicate column.`)
    }
    sourceByCanonical.set(canonical, sourceHeader)
    if (normalizeImportHeader(canonical) !== normalized) aliasesUsed.push(`${sourceHeader} -> ${canonical}`)
  })

  const missingRequired = [...contract.required].filter((header) => !sourceByCanonical.has(header))
  if (missingRequired.length) {
    throw new Error(`${contract.formatName} is missing required columns: ${missingRequired.join(', ')}.`)
  }

  const missingOptional = contract.headers.filter((header) => !contract.required.has(header) && !sourceByCanonical.has(header))
  const missingWithDefaults = missingOptional.filter((header) => contract.optionalDefaults?.[header] !== undefined)
  const missingAsNull = missingOptional.filter((header) => contract.optionalDefaults?.[header] === undefined)
  const warnings = [
    ...(unknown.length ? [`Ignored unknown columns: ${unknown.join(', ')}.`] : []),
    ...(missingAsNull.length ? [`Missing optional columns will be stored as NULL: ${missingAsNull.join(', ')}.`] : []),
    ...(missingWithDefaults.length ? [`Missing optional columns will use defaults: ${missingWithDefaults.map((header) => `${header} = ${contract.optionalDefaults?.[header]}`).join(', ')}.`] : []),
    ...(aliasesUsed.length ? [`Applied column aliases: ${aliasesUsed.join(', ')}.`] : []),
  ]
  return { sourceHeaders: sourceHeaders.map((header) => header.trim()), canonicalByIndex, warnings }
}

export function mapImportRow<Header extends string>(
  values: unknown[],
  mapping: HeaderMapping<Header>,
  headers: readonly Header[],
  rowNumber: number,
  cellText: (value: unknown) => string,
): Record<Header, unknown> {
  const unexpectedValues = values.slice(mapping.sourceHeaders.length).filter((value) => cellText(value))
  if (unexpectedValues.length) {
    throw new Error(`Row ${rowNumber} contains values beyond the ${mapping.sourceHeaders.length} declared columns.`)
  }
  const mapped = Object.fromEntries(headers.map((header) => [header, ''])) as Record<Header, unknown>
  mapping.canonicalByIndex.forEach((header, index) => {
    if (header) mapped[header] = values[index] ?? ''
  })
  return mapped
}
