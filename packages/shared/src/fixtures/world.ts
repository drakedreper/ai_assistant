import type { WorldSnapshot } from '../index'
import { ago } from './time'

/** SEED. The World owner enriches. Relevance notes must be valid paths (see STORY.md). */
export function buildWorld(now: Date): WorldSnapshot {
  return {
    news: [
      { id: 'n1', title: 'Local-first sync engines hit a tipping point', source: 'Builders Weekly', url: 'https://example.com/n1', publishedAt: ago(now, 120), topic: 'tech', summary: 'Three production sync engines shipped stable releases this week.', relevance: { score: 0.94, why: 'Directly supports your Q4 positioning.', note: { path: '10-strategy/q4-positioning.md', title: 'Q4 positioning' } } },
      { id: 'n2', title: 'New agent-monitoring tools appear for coding assistants', source: 'The Dev Report', url: 'https://example.com/n2', publishedAt: ago(now, 300), topic: 'ai', summary: 'A wave of dashboards for coding-agent sessions launched.', relevance: { score: 0.81, why: 'Competes with your Work dashboard idea.', note: { path: '40-projects/assistant/README.md', title: 'Project: ai_assistant' } } },
      { id: 'n3', title: 'Central bank holds rates steady', source: 'World Desk', url: 'https://example.com/n3', publishedAt: ago(now, 420), topic: 'business', summary: 'Rates unchanged; guidance points to a slow thaw next year.', relevance: { score: 0.55, why: 'Affects your savings yield.', note: { path: '10-strategy/financial-independence.md', title: 'Financial independence plan' } } },
      { id: 'n4', title: 'Autumn storm warning for the coast', source: 'Local News', url: 'https://example.com/n4', publishedAt: ago(now, 500), topic: 'local', summary: 'Strong winds expected tomorrow evening.', relevance: { score: 0.3, why: 'Might affect Thursday travel.' } },
    ],
    weather: { location: 'Your city', tempC: 9, condition: 'cloudy', isDay: true, highC: 12, lowC: 5, sunrise: '07:12', sunset: '16:48', attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)' },
    markets: [
      { symbol: 'IDX', label: 'Global index', price: 3128.4, changePct: 0.6, series: [3080, 3092, 3101, 3095, 3110, 3118, 3128] },
      { symbol: 'USD/EUR', label: 'USD to EUR', price: 0.92, changePct: -0.2, series: [0.925, 0.924, 0.923, 0.922, 0.921, 0.921, 0.92] },
    ],
  }
}
