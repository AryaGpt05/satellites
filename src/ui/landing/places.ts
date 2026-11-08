/**
 * Curated example places for the landing chips. Real coordinates, chosen for range: a secret
 * airbase, the densest city block, desert monuments under clear skies, and the Arctic, where polar
 * orbits converge (and where, in winter, optical satellites see nothing at all).
 */
import type { Place } from '@/types'

export interface ExamplePlace extends Place {
  /** Short chip text, mono caps */
  chip: string
}

export const EXAMPLE_PLACES: readonly ExamplePlace[] = [
  { chip: 'Area 51', label: 'Area 51', sublabel: 'Groom Lake, Nevada, United States', lat: 37.235, lon: -115.8111, countryCode: 'us', source: 'demo' },
  { chip: 'Times Square', label: 'Times Square', sublabel: 'New York, United States', lat: 40.758, lon: -73.9855, countryCode: 'us', source: 'demo' },
  { chip: 'Giza', label: 'Pyramids of Giza', sublabel: 'Giza, Egypt', lat: 29.9792, lon: 31.1342, countryCode: 'eg', source: 'demo' },
  { chip: 'Uluru', label: 'Uluru', sublabel: 'Northern Territory, Australia', lat: -25.3444, lon: 131.0369, countryCode: 'au', source: 'demo' },
  { chip: 'Svalbard Seed Vault', label: 'Svalbard Global Seed Vault', sublabel: 'Longyearbyen, Svalbard, Norway', lat: 78.2357, lon: 15.4913, countryCode: 'no', source: 'demo' },
]
