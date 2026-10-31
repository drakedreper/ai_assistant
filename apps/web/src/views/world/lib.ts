import type { MarketQuote, NewsItem, WeatherNow } from '@ai-assistant/shared'
import { Briefcase, Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, Cpu, FlaskConical, Globe, MapPin, Moon, Sun, Bot, type LucideIcon } from 'lucide-react'

export const TOPICS: Record<NewsItem['topic'], { label: string; icon: LucideIcon }> = {
  tech: { label: 'Tech', icon: Cpu },
  ai: { label: 'AI', icon: Bot },
  business: { label: 'Business', icon: Briefcase },
  science: { label: 'Science', icon: FlaskConical },
  world: { label: 'World', icon: Globe },
  local: { label: 'Local', icon: MapPin },
}

export const TOPIC_ORDER: Array<NewsItem['topic']> = ['tech', 'ai', 'business', 'science', 'world', 'local']

export function conditionIcon(c: WeatherNow['condition'], isDay: boolean): LucideIcon {
  switch (c) {
    case 'clear': return isDay ? Sun : Moon
    case 'cloudy': return Cloud
    case 'rain': return CloudRain
    case 'snow': return CloudSnow
    case 'fog': return CloudFog
    case 'storm': return CloudLightning
  }
}

export const CONDITION_LABEL: Record<WeatherNow['condition'], string> = {
  clear: 'Clear',
  cloudy: 'Cloudy',
  rain: 'Rain',
  snow: 'Snow',
  fog: 'Fog',
  storm: 'Storm',
}

export const deg = (n: number): string => `${Math.round(n)}°`

/** "Mon" for a YYYY-MM-DD date. */
export function weekdayShort(date: string): string {
  const [y = '1970', m = '1', d = '1'] = date.split('-')
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-GB', { weekday: 'short' })
}

export function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })
  return p.toFixed(2)
}

export function fmtChange(pct: number): string {
  const v = Math.abs(pct).toFixed(1)
  return `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${v}%`
}

export const isUp = (m: MarketQuote): boolean => m.changePct >= 0

/** Below this, a story is "filed, not pushed". */
export const LOW_MATCH = 0.35
