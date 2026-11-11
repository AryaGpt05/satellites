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

/** A "Surprise me" place: source 'surprise', so usage stats tell it apart from the example chips. */
const sp = (label: string, sublabel: string, lat: number, lon: number, countryCode: string): Place => ({ label, sublabel, lat, lon, countryCode, source: 'surprise' })

/**
 * "Surprise me": famous places you can make out from orbit at the photos' 10–30 m a pixel, in a 10–15 km frame: big
 * landforms, craters and volcanoes, coastlines and harbours, and city layouts (no single statue or building: at 10 m a
 * monument is a few pixels). Mostly in dry or often-clear skies, on every continent. Not a random point: seven tenths
 * of one would be open ocean.
 */
export const SURPRISE_PLACES: readonly Place[] = [
  sp('Uluru', 'Northern Territory, Australia', -25.3444, 131.0369, 'au'),
  sp('Palm Jumeirah', 'Dubai, United Arab Emirates', 25.1124, 55.139, 'ae'),
  sp('The World Islands', 'Dubai, United Arab Emirates', 25.2232, 55.165, 'ae'),
  sp('Grand Canyon', 'Arizona, United States', 36.0544, -112.1401, 'us'),
  sp('Meteor Crater', 'Arizona, United States', 35.0274, -111.0225, 'us'),
  sp('Lower Manhattan', 'New York, United States', 40.7075, -74.0113, 'us'),
  sp('Las Vegas Strip', 'Nevada, United States', 36.1147, -115.1728, 'us'),
  sp('Hoover Dam and Lake Mead', 'Nevada and Arizona, United States', 36.016, -114.7377, 'us'),
  sp('Golden Gate', 'San Francisco, United States', 37.8199, -122.4783, 'us'),
  sp('Kennedy Space Center', 'Florida, United States', 28.6084, -80.6043, 'us'),
  sp('Washington, D.C.', 'The National Mall, United States', 38.8893, -77.0353, 'us'),
  sp('Mount St. Helens', 'Washington, United States', 46.1914, -122.1956, 'us'),
  sp('Niagara Falls', 'Ontario, Canada', 43.0779, -79.0754, 'ca'),
  sp('Panama Canal', 'Gatun Locks, Panama', 9.2726, -79.9218, 'pa'),
  sp('Rio de Janeiro', 'Sugarloaf and Copacabana, Brazil', -22.9486, -43.1566, 'br'),
  sp('Paris', 'Île-de-France, France', 48.8566, 2.3522, 'fr'),
  sp('Venice', 'Veneto, Italy', 45.4341, 12.3388, 'it'),
  sp('Mount Vesuvius', 'Naples, Italy', 40.8214, 14.4265, 'it'),
  sp('Istanbul', 'The Bosphorus, Türkiye', 41.0186, 28.9784, 'tr'),
  sp('Chernobyl', 'Kyiv Oblast, Ukraine', 51.389, 30.099, 'ua'),
  sp('Table Mountain', 'Cape Town, South Africa', -33.9628, 18.4098, 'za'),
  sp('Kilimanjaro', 'Kilimanjaro, Tanzania', -3.0674, 37.3556, 'tz'),
  sp('Mount Everest', 'Nepal and China', 27.9881, 86.925, 'np'),
  sp('Angkor Wat', 'Siem Reap, Cambodia', 13.4125, 103.867, 'kh'),
  sp('Singapore', 'Marina Bay, Singapore', 1.2834, 103.8607, 'sg'),
  sp('Hong Kong', 'Victoria Harbour, Hong Kong', 22.293, 114.1694, 'hk'),
  sp('Tokyo', 'Tokyo, Japan', 35.6812, 139.7671, 'jp'),
  sp('Mount Fuji', 'Shizuoka, Japan', 35.3606, 138.7274, 'jp'),
  sp('Sydney Harbour', 'Sydney, Australia', -33.8568, 151.2153, 'au'),
  // Added after rendering each one's 12 km crop from a recent clear Sentinel-2 scene and looking at it: the subject
  // fills the frame as a shape, colour or texture (a pit, a reef, a caldera, a dam wall, a field pattern).
  sp('Richat Structure', 'Sahara, Mauritania', 21.1243, -11.4005, 'mr'),
  sp('Great Blue Hole', 'Lighthouse Reef, Belize', 17.3158, -87.5347, 'bz'),
  sp('Bora Bora', 'Society Islands, French Polynesia', -16.5004, -151.7415, 'pf'),
  sp('Hardy Reef', 'Great Barrier Reef, Australia', -19.7667, 149.1833, 'au'),
  sp('Malé', 'North Malé Atoll, Maldives', 4.1755, 73.5093, 'mv'),
  sp('Dead Sea Salt Ponds', 'Southern basin, Israel and Jordan', 31.19, 35.45, 'jo'),
  sp('Bingham Canyon Mine', 'Utah, United States', 40.523, -112.15, 'us'),
  sp('Mount Whaleback Mine', 'Pilbara, Australia', -23.3667, 119.6667, 'au'),
  sp('Mount Etna', 'Sicily, Italy', 37.751, 14.9934, 'it'),
  sp('Santorini', 'Cyclades, Greece', 36.404, 25.396, 'gr'),
  sp('Teide', 'Tenerife, Spain', 28.2723, -16.6423, 'es'),
  sp('Kīlauea', 'Hawaii, United States', 19.4069, -155.2834, 'us'),
  sp('Crater Lake', 'Oregon, United States', 42.9446, -122.109, 'us'),
  sp('Glen Canyon Dam', 'Page, Arizona, United States', 36.9371, -111.4837, 'us'),
  sp('Garden City Crop Circles', 'Kansas, United States', 37.9717, -100.8727, 'us'),
  sp('Almería Greenhouses', 'Andalusia, Spain', 36.78, -2.72, 'es'),
  sp('Gibraltar', 'Strait of Gibraltar', 36.1408, -5.3536, 'gi'),
  sp('Suez Canal', 'Ismailia, Egypt', 30.5852, 32.2654, 'eg'),
  sp('Aswan High Dam', 'Lake Nasser, Egypt', 23.97, 32.878, 'eg'),
  sp('Wadi Rum', 'Aqaba, Jordan', 29.5764, 35.4197, 'jo'),
  sp('Sossusvlei', 'Namib Desert, Namibia', -24.7275, 15.2954, 'na'),
  sp('Victoria Falls', 'Zambia and Zimbabwe', -17.9243, 25.8572, 'zw'),
  sp('Three Gorges Dam', 'Hubei, China', 30.8231, 111.0033, 'cn'),
  sp('Shanghai', 'The Huangpu River, China', 31.2304, 121.4737, 'cn'),
  sp('Itaipu Dam', 'Brazil and Paraguay', -25.4086, -54.5889, 'br'),
]

/** A place from SURPRISE_PLACES, never `previous` (two presses in a row always go somewhere new). */
export function surprisePlace(previous?: Pick<Place, 'label'>, random: () => number = Math.random): Place {
  const pool = previous ? SURPRISE_PLACES.filter((p) => p.label !== previous.label) : SURPRISE_PLACES
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]
}
