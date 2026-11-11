/**
 * Curated example places for the landing chips. Real coordinates, chosen so every chip delivers a
 * picture: a secret airbase, a park that reads as a rectangle at 10 m and a desert monument under clear
 * skies (the three most picked of the launch's five chips), plus a "Surprise me" pool of famous places.
 * (The Arctic is out until the radar copy ships: in winter its optical archive is empty.)
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
]

const sp = (label: string, sublabel: string, lat: number, lon: number, countryCode: string): Place => ({ label, sublabel, lat, lon, countryCode, source: 'demo' })

/**
 * "Surprise me": famous places that make a good picture from orbit (big, distinctive, mostly in dry or often-clear
 * skies), on every continent. Not a random point: seven tenths of one would be open ocean.
 */
export const SURPRISE_PLACES: readonly Place[] = [
  sp('Uluru', 'Northern Territory, Australia', -25.3444, 131.0369, 'au'),
  sp('Palm Jumeirah', 'Dubai, United Arab Emirates', 25.1124, 55.139, 'ae'),
  sp('Eiffel Tower', 'Paris, France', 48.8584, 2.2945, 'fr'),
  sp('Statue of Liberty', 'New York, United States', 40.6892, -74.0445, 'us'),
  sp('Grand Canyon', 'Arizona, United States', 36.0544, -112.1401, 'us'),
  sp('Machu Picchu', 'Cusco, Peru', -13.1631, -72.545, 'pe'),
  sp('Taj Mahal', 'Agra, India', 27.1751, 78.0421, 'in'),
  sp('Colosseum', 'Rome, Italy', 41.8902, 12.4922, 'it'),
  sp('Great Wall at Badaling', 'Beijing, China', 40.3587, 116.0204, 'cn'),
  sp('Sydney Opera House', 'Sydney, Australia', -33.8568, 151.2153, 'au'),
  sp('Golden Gate Bridge', 'San Francisco, United States', 37.8199, -122.4783, 'us'),
  sp('Mount Fuji', 'Shizuoka, Japan', 35.3606, 138.7274, 'jp'),
  sp('Burj Khalifa', 'Dubai, United Arab Emirates', 25.1972, 55.2744, 'ae'),
  sp('Petra', "Ma'an, Jordan", 30.3285, 35.4444, 'jo'),
  sp('Christ the Redeemer', 'Rio de Janeiro, Brazil', -22.9519, -43.2105, 'br'),
  sp('Stonehenge', 'Wiltshire, United Kingdom', 51.1789, -1.8262, 'gb'),
  sp('Angkor Wat', 'Siem Reap, Cambodia', 13.4125, 103.867, 'kh'),
  sp('Chichén Itzá', 'Yucatán, Mexico', 20.6843, -88.5678, 'mx'),
  sp('Niagara Falls', 'Ontario, Canada', 43.0779, -79.0754, 'ca'),
  sp('Mount Everest', 'Nepal and China', 27.9881, 86.925, 'np'),
  sp('Eye of the Sahara', 'Richat Structure, Mauritania', 21.124, -11.4017, 'mr'),
  sp('Kennedy Space Center', 'Florida, United States', 28.6084, -80.6043, 'us'),
  sp('Baikonur Cosmodrome', 'Kazakhstan', 45.92, 63.342, 'kz'),
  sp('The Pentagon', 'Virginia, United States', 38.8719, -77.0563, 'us'),
  sp('Venice', 'Veneto, Italy', 45.4341, 12.3388, 'it'),
  sp('Las Vegas Strip', 'Nevada, United States', 36.1147, -115.1728, 'us'),
  sp('Hoover Dam', 'Nevada and Arizona, United States', 36.016, -114.7377, 'us'),
  sp('Vatican City', 'Rome', 41.9022, 12.4539, 'va'),
  sp('Kilimanjaro', 'Kilimanjaro, Tanzania', -3.0674, 37.3556, 'tz'),
  sp('Hollywood Sign', 'Los Angeles, United States', 34.1341, -118.3215, 'us'),
  sp('Sagrada Família', 'Barcelona, Spain', 41.4036, 2.1744, 'es'),
  sp('Table Mountain', 'Cape Town, South Africa', -33.9628, 18.4098, 'za'),
]

/** A place from SURPRISE_PLACES, never `previous` (two presses in a row always go somewhere new). */
export function surprisePlace(previous?: Pick<Place, 'label'>, random: () => number = Math.random): Place {
  const pool = previous ? SURPRISE_PLACES.filter((p) => p.label !== previous.label) : SURPRISE_PLACES
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]
}
