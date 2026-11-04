import type { Catalog } from '@shared/contracts/messages'

export function municipalityName(catalog: Catalog | null, id: number): string {
  return catalog?.municipalities.find((m) => m.id === id)?.name ?? `Municipio ${id}`
}
