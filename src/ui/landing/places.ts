/**
 * Curated example places for the landing chips. Real coordinates, chosen so every chip delivers a
 * picture: a secret airbase, a park that reads as a rectangle at 10 m, desert monuments under clear
 * skies, and a coastline drawn by hand that is usually cloud-free. (The Arctic is out until the radar
 * copy ships: in winter its optical archive is empty.)
 */
import type { Place } from '@/types'

export interface ExamplePlace extends Place {
  /** Short chip text, mono caps */
  chip: string
}

export const EXAMPLE_PLACES: readonly ExamplePlace[] = [
  { chip: 'Area 51', label: 'Area 51', sublabel: 'Groom Lake, Nevada, United States', lat: 37.235, lon: -115.8111, countryCode: 'us', source: 'demo' },
  { chip: 'Central Park', label: 'Central Park', sublabel: 'New York, United States', lat: 40.7812, lon: -73.9665, countryCode: 'us', source: 'demo' },
  { chip: 'Giza', label: 'Pyramids of Giza', sublabel: 'Giza, Egypt', lat: 29.9792, lon: 31.1342, countryCode: 'eg', source: 'demo' },
  { chip: 'Uluru', label: 'Uluru', sublabel: 'Northern Territory, Australia', lat: -25.3444, lon: 131.0369, countryCode: 'au', source: 'demo' },
  { chip: 'Palm Jumeirah', label: 'Palm Jumeirah', sublabel: 'Dubai, United Arab Emirates', lat: 25.1124, lon: 55.139, countryCode: 'ae', source: 'demo' },
]
