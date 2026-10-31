import type { WorldSnapshot } from '../index'
import { ago, dateOnly } from './time'

/** Relevance notes must be valid vault paths (see STORY.md). */
export function buildWorld(now: Date): WorldSnapshot {
  return {
    news: [
      { id: 'n1', title: 'Local-first sync engines hit a tipping point', source: 'Builders Weekly', via: 'rss', url: 'https://example.com/n1', publishedAt: ago(now, 120), topic: 'tech', summary: 'Three production sync engines shipped stable releases this week.', relevance: { score: 0.94, why: 'Directly supports your Q4 positioning.', note: { path: '10-strategy/q4-positioning.md', title: 'Q4 positioning' } } },
      { id: 'n2', title: 'New agent-monitoring tools appear for coding assistants', source: 'The Dev Report', via: 'rss', url: 'https://example.com/n2', publishedAt: ago(now, 300), topic: 'ai', summary: 'A wave of dashboards for coding-agent sessions launched.', relevance: { score: 0.81, why: 'Competes with your Work dashboard idea.', note: { path: '40-projects/assistant/README.md', title: 'Project: ai_assistant' } } },
      { id: 'n-wal', title: 'SQLite in WAL mode: lessons from three years in production', source: 'Hacker News', via: 'hn', points: 412, url: 'https://example.com/n-wal', publishedAt: ago(now, 210), topic: 'tech', summary: 'Checkpoint tuning and one nasty fsync bug, with fixes you can copy.', relevance: { score: 0.77, why: 'Atlas keeps its ledger in SQLite, and the migration session is touching WAL settings right now.', note: { path: '30-knowledge/sqlite-wal.md', title: 'SQLite WAL mode' } } },
      { id: 'n-inject', title: 'Hidden instructions in feed items can steer AI summarisers', source: 'The Dev Report', via: 'rss', url: 'https://example.com/n-inject', publishedAt: ago(now, 340), topic: 'ai', summary: 'Researchers hid commands in feed text to hijack tool-using agents. Tool-less readers were unaffected.', relevance: { score: 0.72, why: 'This is why your Reader lane has no tools. Your operating rules already cover it.', note: { path: '00-core/operating-rules.md', title: 'Operating rules' } } },
      { id: 'n-voice', title: 'Sub-100 ms speech synthesis on a single gaming GPU', source: 'Hacker News', via: 'hn', points: 286, url: 'https://example.com/n-voice', publishedAt: ago(now, 460), topic: 'ai', summary: 'An open-weight voice model streams its first audio in under 100 ms on consumer hardware.', relevance: { score: 0.7, why: 'Her voice latency target lives in the assistant project note, and this beats it.', note: { path: '40-projects/assistant/README.md', title: 'Project: ai_assistant' } } },
      { id: 'n-sync', title: 'Bank-sync providers change pricing for small apps', source: 'World Desk', via: 'rss', url: 'https://example.com/n-sync', publishedAt: ago(now, 600), topic: 'business', summary: 'Per-connection fees rise from January and the free tier shrinks to ten connections.', relevance: { score: 0.66, why: 'Atlas reads bank data through a sync layer. Cost per tester matters for the beta.', note: { path: '30-knowledge/plaid-sync-pattern.md', title: 'Cursor-based transaction sync' } } },
      { id: 'n-deep', title: 'Study: protected morning blocks beat scattered sprints for solo builders', source: 'Science Digest', via: 'rss', url: 'https://example.com/n-deep', publishedAt: ago(now, 760), topic: 'science', summary: 'A survey of 120 independent developers found two uninterrupted blocks shipped the most.', relevance: { score: 0.62, why: 'Matches your deep-work system: two blocks a day, mornings first.', note: { path: '10-strategy/deep-work-system.md', title: 'Deep-work system' } } },
      { id: 'n-a11y', title: 'New accessibility rules start applying to small business websites', source: 'World Desk', via: 'rss', url: 'https://example.com/n-a11y', publishedAt: ago(now, 880), topic: 'world', summary: 'Client sites will need documented accessibility conformance from next year.', relevance: { score: 0.58, why: 'Priya\'s site just had its accessibility pass. A conformance note is a small add-on.', note: { path: '40-projects/site/README.md', title: 'Project: portfolio-site' } } },
      { id: 'n3', title: 'Central bank holds rates steady', source: 'World Desk', via: 'rss', url: 'https://example.com/n3', publishedAt: ago(now, 420), topic: 'business', summary: 'Rates unchanged; guidance points to a slow thaw next year.', relevance: { score: 0.55, why: 'Affects your savings yield.', note: { path: '10-strategy/financial-independence.md', title: 'Financial independence plan' } } },
      { id: 'n-certs', title: 'Short-lived TLS certificates are becoming the default', source: 'The Dev Report', via: 'rss', url: 'https://example.com/n-certs', publishedAt: ago(now, 1100), topic: 'tech', summary: 'Certificate lifetimes keep shrinking, so manual renewal stops being an option.', relevance: { score: 0.48, why: 'Your home-lab still renews certificates by hand.', note: { path: '40-projects/homelab/README.md', title: 'Project: home-lab' } } },
      { id: 'n4', title: 'Autumn storm warning for the coast', source: 'Local News', via: 'rss', url: 'https://example.com/n4', publishedAt: ago(now, 500), topic: 'local', summary: 'Strong winds expected tomorrow evening.', relevance: { score: 0.3, why: 'Might affect Thursday travel.' } },
      { id: 'n-battery', title: 'New battery chemistry passes 1,000 charge cycles in a lab test', source: 'Science Digest', via: 'rss', url: 'https://example.com/n-battery', publishedAt: ago(now, 1300), topic: 'science', summary: 'Promising, but still about two years from a product.', relevance: { score: 0.14, why: 'Interesting, not actionable. I filed it so you do not have to.' } },
    ],
    weather: {
      location: 'Your city',
      tempC: 9,
      condition: 'cloudy',
      isDay: true,
      highC: 12,
      lowC: 5,
      sunrise: '07:12',
      sunset: '16:48',
      attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
      feelsLikeC: 6,
      windKph: 18,
      precipPct: 30,
      daily: [
        { date: dateOnly(now, 1), condition: 'storm', highC: 11, lowC: 7 },
        { date: dateOnly(now, 2), condition: 'rain', highC: 10, lowC: 6 },
        { date: dateOnly(now, 3), condition: 'cloudy', highC: 11, lowC: 4 },
        { date: dateOnly(now, 4), condition: 'clear', highC: 13, lowC: 3 },
        { date: dateOnly(now, 5), condition: 'fog', highC: 9, lowC: 2 },
      ],
    },
    markets: [
      { symbol: 'IDX', label: 'Global index', price: 3128.4, changePct: 0.6, series: [3080, 3092, 3101, 3095, 3110, 3118, 3128.4] },
      { symbol: 'TECH', label: 'Tech index', price: 5412.7, changePct: 1.1, series: [5301, 5322, 5290, 5348, 5361, 5353, 5412.7] },
      { symbol: 'USD/EUR', label: 'USD to EUR', price: 0.92, changePct: -0.2, series: [0.925, 0.924, 0.923, 0.922, 0.921, 0.921, 0.92] },
      { symbol: 'GOLD', label: 'Gold, per oz', price: 2648.2, changePct: -0.4, series: [2671, 2664, 2669, 2660, 2657, 2659, 2648.2] },
      { symbol: '10Y', label: '10-year yield, %', price: 3.42, changePct: 0.9, series: [3.36, 3.34, 3.38, 3.37, 3.4, 3.39, 3.42] },
    ],
    signals: [
      {
        id: 'sig-local-first',
        title: 'Local-first keeps gaining speed',
        summary: 'Sync engines, SQLite lessons and local voice models all landed in the same week. Your Q4 wedge is riding a real current.',
        strength: 'strong',
        itemIds: ['n1', 'n-wal', 'n-voice'],
        notes: [
          { path: '10-strategy/q4-positioning.md', title: 'Q4 positioning' },
          { path: '30-knowledge/local-first-software.md', title: 'Local-first software' },
        ],
      },
      {
        id: 'sig-agents',
        title: 'Agent tooling is crowding in, and safety is the story',
        summary: 'More dashboards for coding agents, plus a new attack on tool-using summarisers. Both sharpen what makes your approvals-first design different.',
        strength: 'growing',
        itemIds: ['n2', 'n-inject'],
        notes: [
          { path: '00-core/operating-rules.md', title: 'Operating rules' },
          { path: '40-projects/assistant/README.md', title: 'Project: ai_assistant' },
        ],
      },
      {
        id: 'sig-costs',
        title: 'Small-app infrastructure costs are drifting up',
        summary: 'Higher bank-sync fees and steady rates both lean on your Atlas pricing and your savings assumptions.',
        strength: 'watching',
        itemIds: ['n-sync', 'n3'],
        notes: [
          { path: '10-strategy/financial-independence.md', title: 'Financial independence plan' },
          { path: '30-knowledge/plaid-sync-pattern.md', title: 'Cursor-based transaction sync' },
        ],
      },
    ],
  }
}
