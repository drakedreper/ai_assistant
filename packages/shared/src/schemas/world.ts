import { z } from 'zod'
import { Id, IsoDateTime } from './common'

export const NewsItem = z.object({
  id: Id,
  title: z.string(),
  source: z.string(),
  url: z.string(),
  publishedAt: IsoDateTime,
  topic: z.enum(['world', 'tech', 'ai', 'business', 'science', 'local']),
  /** Where it came from: an RSS feed or Hacker News. */
  via: z.enum(['rss', 'hn']).optional(),
  /** Hacker News points, when via is 'hn'. */
  points: z.number().int().optional(),
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
  feelsLikeC: z.number().optional(),
  windKph: z.number().optional(),
  /** Chance of precipitation today, 0-100. */
  precipPct: z.number().optional(),
  /** The next few days, for a mini forecast. */
  daily: z
    .array(z.object({ date: z.string(), condition: z.enum(['clear', 'cloudy', 'rain', 'snow', 'fog', 'storm']), highC: z.number(), lowC: z.number() }))
    .optional(),
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

/** A cross-cutting theme Mira noticed across several stories, tied to the user's own notes. */
export const WorldSignal = z.object({
  id: Id,
  title: z.string(),
  summary: z.string(),
  strength: z.enum(['strong', 'growing', 'watching']),
  /** NewsItem ids that make up the signal. */
  itemIds: z.array(Id),
  notes: z.array(z.object({ path: z.string(), title: z.string() })).default([]),
})
export type WorldSignal = z.infer<typeof WorldSignal>

export const WorldSnapshot = z.object({
  news: z.array(NewsItem),
  weather: WeatherNow,
  markets: z.array(MarketQuote),
  signals: z.array(WorldSignal).optional(),
})
export type WorldSnapshot = z.infer<typeof WorldSnapshot>
