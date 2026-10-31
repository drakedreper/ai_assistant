import { z } from 'zod'
import { Id, IsoDateTime } from './common'

export const NewsItem = z.object({
  id: Id,
  title: z.string(),
  source: z.string(),
  url: z.string(),
  publishedAt: IsoDateTime,
  topic: z.enum(['world', 'tech', 'ai', 'business', 'science', 'local']),
  /** One-line summary written by her (Reader lane, tool-less). */
  summary: z.string(),
  /** Why it matters to YOU: cites a project or strategy. This is the re-rank signal. */
  relevance: z.object({
    score: z.number().min(0).max(1),
    why: z.string(),
    note: z.object({ path: z.string(), title: z.string() }).optional(),
  }),
})
export type NewsItem = z.infer<typeof NewsItem>

export const WeatherNow = z.object({
  location: z.string(),
  tempC: z.number(),
  condition: z.enum(['clear', 'cloudy', 'rain', 'snow', 'fog', 'storm']),
  isDay: z.boolean(),
  highC: z.number(),
  lowC: z.number(),
  sunrise: z.string(),
  sunset: z.string(),
  /** Attribution required by Open-Meteo (CC BY 4.0). */
  attribution: z.string(),
})
export type WeatherNow = z.infer<typeof WeatherNow>

export const MarketQuote = z.object({
  symbol: z.string(),
  label: z.string(),
  price: z.number(),
  changePct: z.number(),
  /** Tiny sparkline series. */
  series: z.array(z.number()),
})
export type MarketQuote = z.infer<typeof MarketQuote>

export const WorldSnapshot = z.object({
  news: z.array(NewsItem),
  weather: WeatherNow,
  markets: z.array(MarketQuote),
})
export type WorldSnapshot = z.infer<typeof WorldSnapshot>
