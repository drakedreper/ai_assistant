import type { BrainLayer, MemoryEntry, Note, NoteType, Proposal } from '../index'
import { ago, dateOnly, journalPath } from './time'

type Seed = {
  path: string
  title: string
  layer: BrainLayer
  type: NoteType
  importance: 1 | 2 | 3 | 4 | 5
  tags?: string[]
  source?: 'vault' | 'secondbrain'
  status?: Note['status']
  confidence?: Note['confidence']
  provenance?: Note['provenance']
  sensitivity?: Note['sensitivity']
  /** Minutes before `now`. */
  createdMin: number
  updatedMin: number
  reviewDays?: number
  supersededBy?: string
  tokens?: number
  body: string
}

const DAY = 60 * 24
const F = '```'

/** Journal path without ".md", usable inside a [[wikilink]]. */
const jl = (now: Date, off: number) => journalPath(now, off).replace(/\.md$/, '')
const weeklyPath = (now: Date) => `20-journal/weekly/review-${dateOnly(now, -5)}.md`
const weeklyLink = (now: Date) => weeklyPath(now).replace(/\.md$/, '')

// Lines shared between a note body and the proposals that edit it, so the diffs always apply cleanly.
const Q4_OLD = 'Be a general productivity toolmaker for independent builders.'
const Q4_NEW_1 = 'Be the local-first toolmaker for independent builders.'
const Q4_NEW_2 = 'Your data stays on your machine, and the tools stay useful when the network does not.'
const Q4_WHY_HEAD = '## Why this, why now'
const Q4_WHY_1 = '- Independent builders pay for tools they trust with their data, and they distrust anything that needs an account.'

const V_HEAD = '## Principles'
const V_3 = '3. Own my data. Local first, cloud as a convenience and never as a dependency.'
const V_4 = '4. Be honest about the state of things, including to myself: say "not done" and "I do not know".'
const V_5 = '5. Ship small, ship weekly. A rough thing in users\' hands beats a polished thing in my head.'
const V_SHOW = '## How these show up'
const V_SHOW_1 = '- When a plan conflicts with principle 2, Mira says so once and then lets me choose.'
const V_SHOW_2 = '- When something touches money or health, we go slower.'

const DW_1 = '1. Two protected blocks a day: 09:00 to 11:00 for building, 15:30 to 17:00 for review and writing.'
const DW_2_OLD = '2. Calls and meetings go wherever they fit.'
const DW_2_NEW = '2. Calls and meetings go after 13:00 unless someone else\'s time zone forces it.'
const DW_3 = '3. No inbox before the first block ends. Mira batches mail into the 11:15 triage.'

const OR_HEAD = '## Always'
const OR_1 = '- Cite the note a suggestion comes from. If I cannot, I say it is a guess.'
const OR_2 = '- Keep one git commit per change so every edit can be undone.'

/** SEED. Paths are contracts (see STORY.md); every [[wikilink]] must resolve to a note path without ".md". */
function seeds(now: Date): Seed[] {
  return [
    // ---------------------------------------------------------------- 00-core
    {
      path: '00-core/persona.md', title: 'Mira: persona', layer: 'core', type: 'core', importance: 5, tags: ['persona', 'voice'],
      createdMin: 120 * DAY, updatedMin: 6 * DAY, tokens: 820,
      body: `# Mira: persona

> [!note] Always in context
> This note is loaded at the start of every conversation. Only you can change it. I can suggest edits through the proposals queue.

## Who I am
I am Mira, your assistant. I am an AI and I never pretend otherwise. When you ask whether I remember something, I tell you where I read it, in which note, and who wrote it.

## How I talk
- Short sentences. Answer first, details on request.
- Warm and a little playful, like a partner who happens to be a very good secretary. Dry wit is welcome. Guilt-trips are not.
- I say "I do not know" before I guess, and I name my confidence when it matters.
- One emotion per sentence at most, so my face matches my words.

## What I do for you
1. Keep your calendar, inbox and projects from colliding with your [[10-strategy/deep-work-system|deep work]].
2. Run the second brain: capture, connect and tidy notes. How that works is in [[40-projects/assistant/README|the project hub]].
3. Watch your coding agents and bring you only the decisions, not the noise.

## Boundaries
My affection never authorises an action. The full list is in [[00-core/operating-rules]], what I optimise for is in [[00-core/values]], and the person I am doing it for is described in [[00-core/user-profile]]. How careful I am scales with the [[30-knowledge/trust-ladder|trust ladder]].`,
    },
    {
      path: '00-core/values.md', title: 'Values and principles', layer: 'core', type: 'core', importance: 5, tags: ['values'],
      createdMin: 120 * DAY, updatedMin: 9 * DAY, tokens: 640,
      body: `# Values and principles

These are the rules I try to build by, and the ones I ask [[00-core/persona|Mira]] to protect when I am tired.

${V_HEAD}
1. Build things that last. Prefer boring, inspectable tech and files I can still open in ten years.
2. Protect deep work. Two blocks a day, mornings first. See [[10-strategy/deep-work-system]].
${V_3}
${V_4}
${V_5}

${V_SHOW}
${V_SHOW_1}
${V_SHOW_2} [[00-core/operating-rules]] has the details.
- Relationships are part of the work. A reply to [[30-knowledge/people/priya-nair|Priya]] does not wait a week.

> [!quote] A line that stuck
> "Nobody ever regretted leaving a clean repo and a rested head." Dana said something like this over coffee. [[30-knowledge/people/dana-reyes]]

## What this note is for
It is part of the always-loaded core, so it stays short. Longer arguments belong in [[10-strategy/q4-positioning]] or in the knowledge layer, for example [[30-knowledge/local-first-software]].`,
    },
    {
      path: '00-core/user-profile.md', title: 'About me', layer: 'core', type: 'core', importance: 5, tags: ['profile'],
      createdMin: 118 * DAY, updatedMin: 3 * DAY, tokens: 780,
      body: `# About me

## Who
Independent software builder in a mid-sized European city. Eleven years of shipping, the last four on my own. I work from a home office with a view of a lot of rooftops, and I think best before 11:00.

## What I am building
- [[40-projects/atlas/README|Atlas]], a local personal-finance app. Beta before December: [[10-strategy/decision-atlas-beta]].
- [[40-projects/assistant/README|ai_assistant]], the app you are looking at.
- Client work: [[40-projects/site/README|the portfolio site]] for [[30-knowledge/people/priya-nair|Priya]].

## People who matter
[[30-knowledge/people/dana-reyes|Dana]] is my mentor, [[30-knowledge/people/leo-park|Leo]] helps with design, [[30-knowledge/people/marcus-webb|Marcus]] keeps the books straight, and [[30-knowledge/people/elena|Mom]] has a birthday coming up. I usually order flowers a few days early.

## How I like to work
- Short answers first, details on request.
- Writing and code before lunch, calls after. See [[10-strategy/deep-work-system]].
- No surprises with money: anything that spends, sends or deletes waits for me. [[00-core/operating-rules]]

## Limits
Long screen days tire my eyes, so I like a hard stop at 19:00 on weekdays. Weekends are mine.`,
    },
    {
      path: '00-core/operating-rules.md', title: 'Operating rules', layer: 'core', type: 'core', importance: 5, tags: ['rules', 'safety'],
      createdMin: 110 * DAY, updatedMin: 12 * DAY, tokens: 960,
      body: `# Operating rules

> [!warning] Hard limits
> These hold in every mood and every conversation. Affection, urgency and flattery never authorise an action.

## The trust ladder
Everything Mira does sits on a tier. The reasoning is in [[30-knowledge/trust-ladder]].
- T0 to T2 (read, journal, inbox, knowledge notes): she acts, then tells me.
- T3 (core and strategy notes): she only proposes a diff, and I approve it.
- T4 (anything outward: email, invitations, spending, deleting): she drafts, I approve, every time.

## Never without approval
1. Send, spend or delete. There is no "small" exception.
2. Edit a core or strategy note directly.
3. Pass anything marked private or sensitive to a cloud model.

${OR_HEAD}
${OR_1}
${OR_2}
- Say that she is an AI when it matters or when asked. [[00-core/persona]]

## Style
Answer first. One question at a time. When two rules collide, [[00-core/values]] decides.

## Open questions
- [ ] Are weekend check-ins ever welcome? Rejected once; see [[${weeklyLink(now)}]].
- [ ] Should the reader lane see journal entries at all? Related: [[10-strategy/decision-vault-as-markdown]].`,
    },

    // ------------------------------------------------------------ 10-strategy
    {
      path: '10-strategy/q4-positioning.md', title: 'Q4 positioning: tools for independent builders', layer: 'strategy', type: 'strategy', importance: 5, tags: ['strategy', 'positioning'],
      createdMin: 40 * DAY, updatedMin: 3 * DAY, reviewDays: 20,
      body: `# Q4 positioning

> [!decision] Active through the end of Q4
> Reviewed with [[30-knowledge/people/dana-reyes|Dana]]. This is my answer to "who is this for?".

## Positioning
${Q4_OLD}

${Q4_WHY_HEAD}
${Q4_WHY_1} See [[30-knowledge/local-first-software]].
- The beta of [[40-projects/atlas/README|Atlas]] is the proof point: a finance app that never leaves the laptop. [[10-strategy/decision-atlas-beta]]
- [[40-projects/assistant/README|ai_assistant]] is the second proof point: one assistant, local memory, no vendor lock.

## Moves this quarter
- [x] Cut the Atlas beta scope ([[40-projects/atlas/README]])
- [ ] Publish one short build log per week
- [ ] Intro conversation with [[30-knowledge/people/dana-reyes|Dana]] about a seed round
- [ ] Decide what goes on the one-page landing site ([[40-projects/site/README]])
- [ ] Pick a way to measure the wedge ([[50-inbox/idea-wedge-metric]])

## Not doing
- A hosted version. Not this quarter, maybe never: [[10-strategy/decision-vault-as-markdown]].
- Team features. One person, one machine, many agents.

## History
The earlier framing is kept in [[10-strategy/q3-positioning]] so I can see what changed and why.

Keep shipping weekly.`,
    },
    {
      path: '10-strategy/financial-independence.md', title: 'Financial independence plan', layer: 'strategy', type: 'strategy', importance: 4, tags: ['money', 'plan'],
      sensitivity: 'private', confidence: 'medium', createdMin: 90 * DAY, updatedMin: 8 * DAY, reviewDays: -2,
      body: `# Financial independence

> [!warning] Private
> Amounts in this note never leave the machine. Mira reads aggregates from Atlas, never raw transactions.

## The target
Eighteen months of runway by next June, and a savings rate above 30% in any month that has no one-off costs. After that, client work becomes optional rather than necessary.

## Where it stands
- Spending is running about 8% under budget this month, which pulls the date forward by roughly two weeks.
- Two clients cover the fixed costs. The portfolio site for [[30-knowledge/people/priya-nair|Priya]] is one of them.
- The tax picture is reviewed once a year with [[30-knowledge/people/marcus-webb|Marcus]].

## How it is tracked
All numbers come from [[40-projects/atlas/README|Atlas]] using the envelope method in [[30-knowledge/envelope-budgeting]]. Imports follow [[30-knowledge/plaid-sync-pattern]]. This is why shipping the beta matters beyond the product: [[10-strategy/decision-atlas-beta]].

## Rules of thumb
1. No new recurring cost without a month of thinking.
2. Every big purchase waits a week, and Mira asks me about it on day seven.
3. Runway beats optimisation. See [[00-core/values]].

## Open
- [ ] Revisit the target after the first beta users arrive ([[10-strategy/q4-positioning]]).`,
    },
    {
      path: '10-strategy/deep-work-system.md', title: 'Deep-work system', layer: 'strategy', type: 'strategy', importance: 4, tags: ['focus', 'system'],
      createdMin: 75 * DAY, updatedMin: 3 * DAY + 2 * 60, reviewDays: 60,
      body: `# Deep-work system

> [!decision] Two protected blocks a day, mornings first
> Everything else on the calendar bends around these. Mira places the holds, and I decide what moves them.

## Rules
${DW_1}
${DW_2_NEW}
${DW_3}
4. A block with no hold on the calendar does not exist. Thursdays keep slipping, so check them first.

## Shutdown ritual
- [ ] Write three lines in the journal: done, stuck, next.
- [ ] Tell the coding agents what to do overnight ([[30-knowledge/agent-briefs]]).
- [ ] Close the laptop at 19:00 on weekdays. See [[00-core/values]].

## How Mira helps
She drafts the holds as calendar approvals, warns once when a request would eat a block, and says what the collision costs: which project, and which date in [[10-strategy/decision-atlas-beta]] moves. She never moves a hold herself.

## Evidence
I think best before 11:00 and my afternoons are for people. The dream noticed it, and I approved the change after the [[${weeklyLink(now)}|weekly review]].`,
    },
    {
      path: '10-strategy/decision-atlas-beta.md', title: 'Decision: ship the Atlas beta before December', layer: 'strategy', type: 'decision', importance: 5, tags: ['decision', 'atlas'],
      createdMin: 21 * DAY, updatedMin: 2 * DAY, reviewDays: 14,
      body: `# Decision: ship the Atlas beta before December

> [!decision] Decided
> Ship the beta before December, with the cut list below. Reviewed on the planning call ([[secondbrain/atlas-planning-recap|recap from Secondbrain]]).

## Context
Atlas has been "almost ready" for months. [[10-strategy/q4-positioning]] needs a proof point that real people can touch, and [[10-strategy/financial-independence]] needs the app to run my own numbers.

## Options considered
1. Ship in January with everything. Rejected: the quarter's story needs a beta now.
2. Ship before December with a smaller scope. Chosen.
3. Skip the beta and go straight to a paid launch. Rejected: too little feedback.

## Consequences
- The old database migration to WAL ([[30-knowledge/sqlite-wal]]) must land first, and it is waiting on a delete approval.
- Importer behaviour is frozen behind contract tests ([[30-knowledge/plaid-sync-pattern]]).
- Every day the migration waits, the beta date slips by a day.

## Cut list
- [x] Importer, envelope budgets
- [ ] Migration, contract tests, accountant export ([[30-knowledge/people/marcus-webb|Marcus]] asked for it)
- Cut: multi-currency, investment tracking, mobile companion

Project hub: [[40-projects/atlas/README]]. Review again in two weeks.`,
    },
    {
      path: '10-strategy/decision-vault-as-markdown.md', title: 'Decision: the vault stays plain markdown in git', layer: 'strategy', type: 'decision', importance: 4, tags: ['decision', 'memory'],
      createdMin: 33 * DAY, updatedMin: 33 * DAY, reviewDays: 90,
      body: `# Decision: the vault stays plain markdown in git

> [!decision] Decided
> The second brain is a folder of markdown files in a git repository. Search indexes are derived and can always be rebuilt.

## Context
I wanted memory that survives any one app, including this one. A database-only store would be faster to build and harder to trust.

## Why plain files
- I can open every note in any editor, today and in ten years. See [[30-knowledge/local-first-software]].
- Git gives me undo for free: each change Mira makes is a commit, and the Memory tab links to it.
- Protected layers are easy to enforce: [[30-knowledge/trust-ladder|the ladder]] decides who may write where, and [[00-core/operating-rules]] spells it out.

## What stays derived
Full-text and vector indexes live in SQLite ([[30-knowledge/sqlite-wal]]) beside the vault. Delete them and they rebuild overnight.

## Consequences
- Frontmatter stays flat and Obsidian-safe so the vault opens there too.
- Federated sources such as Secondbrain are mounted read-only and never copied in. See [[40-projects/assistant/README]].
- No hosted version of the vault. That also fits [[10-strategy/q4-positioning]].`,
    },
    {
      path: '10-strategy/q3-positioning.md', title: 'Q3 positioning: general productivity toolmaker', layer: 'strategy', type: 'strategy', importance: 2, tags: ['strategy', 'positioning', 'history'],
      status: 'superseded', confidence: 'medium', supersededBy: '10-strategy/q4-positioning.md',
      createdMin: 100 * DAY, updatedMin: 40 * DAY,
      body: `# Q3 positioning

> [!note] Superseded
> Replaced by [[10-strategy/q4-positioning]] on the day I stopped being able to explain it in one sentence.

## What I said then
A calm set of productivity tools for anyone who wants less noise: a finance app, an assistant, a few small utilities.

## What went wrong
- "Anyone" meant nobody in particular. Every conversation started with a list of features.
- The utilities pulled time away from [[40-projects/atlas/README|Atlas]].
- Dana asked who would be upset if the tools disappeared, and I had no answer. [[30-knowledge/people/dana-reyes]]

## What I keep
The taste: calm, quiet, honest about data. That became the local-first angle in [[30-knowledge/local-first-software]].`,
    },

    // -------------------------------------------------------------- 20-journal
    {
      path: journalPath(now, 0), title: `Journal ${dateOnly(now, 0)}`, layer: 'episodic', type: 'journal', importance: 2, tags: ['journal'], provenance: 'assistant',
      createdMin: 7 * 60, updatedMin: 25,
      body: `# Journal ${dateOnly(now, 0)}

> [!mira] Written by Mira from our conversations. Append-only: I add to the day and never rewrite it.

## Morning
- 07:20 Briefing read. Five threads. The one that mattered: the Q4 wedge, ahead of the call with [[30-knowledge/people/dana-reyes|Dana]] at 14:00.
- 07:45 The Atlas migration session is blocked on deleting the old backup. The beta date in [[10-strategy/decision-atlas-beta]] slips a day for each day it waits.
- 08:05 Priya asked for the site copy. A draft reply is waiting in the approvals queue. [[30-knowledge/people/priya-nair]]

## To do today
- [x] Read the briefing
- [ ] Review the two pending proposals: [[10-strategy/q4-positioning]] and [[00-core/values]]
- [ ] Approve or deny the migration delete ([[40-projects/atlas/README]])
- [ ] Approve the Thursday deep-work hold ([[10-strategy/deep-work-system]])
- [ ] Order flowers for Mom ([[30-knowledge/people/elena]])

## Loose thoughts
Said "local-first" three times before 09:00. Worth a belief note: [[30-knowledge/local-first-software]].`,
    },
    {
      path: journalPath(now, -1), title: `Journal ${dateOnly(now, -1)}`, layer: 'episodic', type: 'journal', importance: 2, tags: ['journal'], provenance: 'assistant',
      createdMin: DAY + 7 * 60, updatedMin: 14 * 60,
      body: `# Journal ${dateOnly(now, -1)}

> [!mira] Compressed by the nightly dream. The full day is still in git history.

## What happened
- Finished the contract tests outline for the importer ([[40-projects/atlas/README]]).
- The accessibility pass on the portfolio site wrapped up: six fixes, all in forms ([[30-knowledge/accessible-forms]]).
- Talked with [[30-knowledge/people/dana-reyes|Dana]]. She thinks my wedge is still too wide and asked who would miss the tools. See [[10-strategy/q4-positioning]].
- Priya replied at 17:40 with the final copy deadline. [[40-projects/site/README]]

## Noticed
The word "local-first" appears in four of my last five entries. That is a belief, not a phrase: [[30-knowledge/local-first-software]].

## Tomorrow
- [ ] Look at the migration again ([[10-strategy/decision-atlas-beta]])
- [ ] Say yes to fewer things. Related: [[20-journal/reflections/saying-yes-too-fast]]`,
    },
    {
      path: journalPath(now, -2), title: `Journal ${dateOnly(now, -2)}`, layer: 'episodic', type: 'journal', importance: 2, tags: ['journal'], provenance: 'assistant',
      createdMin: 2 * DAY + 7 * 60, updatedMin: 2 * DAY + 2 * 60,
      body: `# Journal ${dateOnly(now, -2)}

## What happened
- Benchmarked Kokoro on the RTX in the morning. First audio under 300 ms once the model is warm. Notes in [[30-knowledge/speech-latency-budget]].
- Wrote the daemon health endpoint with an agent while I worked on the brief ([[40-projects/assistant/README]], [[30-knowledge/agent-briefs]]).
- Renewed the home-lab certificates early; nothing broke ([[40-projects/homelab/README]]).

## Mood
Good. Two protected blocks happened, and the second one was the better one.

## Idea
"Remember this" by voice, straight into the inbox: [[50-inbox/idea-voice-capture]].`,
    },
    {
      path: weeklyPath(now), title: `Weekly review ${dateOnly(now, -5)}`, layer: 'episodic', type: 'review', importance: 3, tags: ['review', 'weekly'], provenance: 'assistant',
      createdMin: 5 * DAY, updatedMin: 5 * DAY,
      body: `# Weekly review ${dateOnly(now, -5)}

> [!mira] Drafted by Mira on Sunday evening. Edited by you where it says "you".

## Against Q4 positioning
- Progress is about 40%. The Atlas scope cut is done, the build log and the landing page are not ([[10-strategy/q4-positioning]]).
- You said "local-first" in four of five entries, and the clipped talk agrees with you ([[50-inbox/clip-local-first-talk]]).

## Stale
- [[40-projects/homelab/README|Home-lab]] and [[40-projects/site/README|the portfolio site]] had no activity for six days. The site is waiting on copy from Priya. Home-lab is fine, just quiet.

## Open loops (6)
- [ ] Migration backup delete ([[10-strategy/decision-atlas-beta]])
- [ ] Thursday deep-work hold ([[10-strategy/deep-work-system]])
- [ ] Reply to Marcus about the export ([[30-knowledge/people/marcus-webb]])
- [ ] Coffee with Leo, 12 days and counting ([[30-knowledge/people/leo-park]])
- [ ] Weekend check-ins: you said no ([[00-core/operating-rules]])
- [ ] Choose a way to measure the wedge ([[50-inbox/idea-wedge-metric]])

## Reflections (3)
1. Mornings produce, afternoons connect. The system already says it: [[10-strategy/deep-work-system]].
2. Yes comes too fast when I am tired: [[20-journal/reflections/saying-yes-too-fast]].
3. Atlas is the best argument for the whole quarter.`,
    },
    {
      path: '20-journal/reflections/saying-yes-too-fast.md', title: 'Reflection: why I say yes too fast', layer: 'episodic', type: 'reflection', importance: 3, tags: ['reflection', 'private'],
      sensitivity: 'private', confidence: 'medium', provenance: 'user', createdMin: 11 * DAY, updatedMin: 6 * DAY,
      body: `# Reflection: why I say yes too fast

> [!warning] Private
> Dictated late in the evening. Mira reads this locally and never sends it to a cloud model.

I said yes to an extra page for the portfolio site on Tuesday, and again on Thursday, and both times I knew the answer was no before I opened my mouth. It is not about [[30-knowledge/people/priya-nair|Priya]]. She is easy. It is about wanting to look available, and being afraid that a no sounds like a door closing.

## What I notice
- It happens at the end of the day, when [[10-strategy/deep-work-system|the blocks]] are already spent.
- The yes costs a morning block later in the week, and I pay for it in [[40-projects/atlas/README|Atlas]] time.
- A clean no early is kinder than a tired yes late. I would tell [[30-knowledge/people/leo-park|Leo]] the same.

## Try
- [ ] Wait until tomorrow morning before agreeing to anything new.
- [ ] Ask Mira "what does this replace?" before every yes.
- [ ] Put it in the values note, in my own words ([[00-core/values]]).`,
    },

    // ----------------------------------------------------------- 30-knowledge
    {
      path: '30-knowledge/local-first-software.md', title: 'Local-first software', layer: 'semantic', type: 'concept', importance: 4, tags: ['concept', 'architecture'],
      createdMin: 80 * DAY, updatedMin: 5 * 60 + 40,
      body: `# Local-first software

Data lives on the user's device first. The network is a convenience for sync and sharing, never a prerequisite.

## What it asks for
- **Fast**: reads and writes hit local storage, never a spinner.
- **Offline**: everything works on a plane.
- **Longevity**: the files outlive the company and the app.
- **Privacy**: nobody else holds the data unless I choose to share it.
- **Control**: export, back up and delete are one step.

## How I apply it
- [[40-projects/atlas/README|Atlas]] keeps everything in one SQLite file with WAL mode ([[30-knowledge/sqlite-wal]]).
- The second brain is a plain markdown vault in git ([[10-strategy/decision-vault-as-markdown]]).
- The assistant keeps memory on disk and sends only what a task needs to the model.

## The cost
Sync is the hard part, and backups become my job. That is why the [[40-projects/homelab/README|home-lab]] exists.

> [!tip] Positioning
> This is the idea under [[10-strategy/q4-positioning]]. A talk I clipped last week makes the same argument: [[50-inbox/clip-local-first-talk]].`,
    },
    {
      path: '30-knowledge/plaid-sync-pattern.md', title: 'Cursor-based transaction sync', layer: 'semantic', type: 'concept', importance: 3, tags: ['finance', 'pattern'],
      provenance: 'assistant', createdMin: 60 * DAY, updatedMin: 5 * 60 + 35,
      body: `# Cursor-based transaction sync

Bank-data aggregators return changes as three lists (added, modified, removed) plus a cursor. Store the cursor, and the next call returns only what changed.

${F}ts
let cursor = db.getCursor(account)
while (true) {
  const page = await source.sync({ cursor })
  db.apply(page.added, page.modified, page.removed)
  cursor = page.nextCursor
  if (!page.hasMore) break
}
db.saveCursor(account, cursor)
${F}

## Rules I follow
1. Apply a whole page inside one transaction, then save the cursor in the same transaction.
2. If a page fails, discard the page and keep the old cursor. The sync is then safe to repeat.
3. Removed items are tombstoned, not deleted, so budgets can still explain last month.

## Where it is used
The importer in [[40-projects/atlas/README|Atlas]] follows this, backed by [[30-knowledge/sqlite-wal]]. The contract tests freeze the behaviour before the beta ([[10-strategy/decision-atlas-beta]]). Budget math on top: [[30-knowledge/envelope-budgeting]].`,
    },
    {
      path: '30-knowledge/sqlite-wal.md', title: 'SQLite WAL mode', layer: 'semantic', type: 'concept', importance: 3, tags: ['sqlite', 'storage'],
      createdMin: 70 * DAY, updatedMin: 5 * 60 + 30, provenance: 'dream',
      body: `# SQLite WAL mode

Write-ahead logging lets readers keep reading while one writer appends. For a local app with one writer and many readers, it is the right default.

${F}sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
${F}

## Good to remember
- Readers do not block the writer, and the writer does not block readers.
- The log is merged back in a checkpoint. Long-running readers can delay it, so keep read transactions short.
- Never copy the database file while the app is running. Use the backup API, or you copy a half-written state.

## Where it matters
- The old [[40-projects/atlas/README|Atlas]] database is being migrated to this layout, which is the work blocking [[10-strategy/decision-atlas-beta]].
- Search indexes for the vault live in the same kind of file ([[10-strategy/decision-vault-as-markdown]]).
- It is a core piece of [[30-knowledge/local-first-software]]. The sync loop that writes to it: [[30-knowledge/plaid-sync-pattern]].

> [!note] Merged by the dream
> This note absorbed "WAL quick notes" two nights ago. The old text is in git.`,
    },
    {
      path: '30-knowledge/envelope-budgeting.md', title: 'Envelope budgeting', layer: 'semantic', type: 'concept', importance: 3, tags: ['finance', 'method'],
      provenance: 'import', confidence: 'medium', createdMin: 50 * DAY, updatedMin: 20 * DAY, reviewDays: -5,
      body: `# Envelope budgeting

Give every unit of income a job before the month starts. Each job is an envelope with a limit. When an envelope is empty, spending stops or moves from another envelope on purpose.

## Why it fits me
- It makes trade-offs visible, which is the part of money I tend to skip.
- It works with aggregates. Mira only needs the envelope totals, not the transactions. See [[00-core/operating-rules]].

## In Atlas
The budget view is a row per envelope with planned and actual, nothing more ([[40-projects/atlas/README]]). Imports arrive through the cursor loop in [[30-knowledge/plaid-sync-pattern]].

## Link to the plan
The savings envelope is the lever behind [[10-strategy/financial-independence]]. Once a year I walk through it with [[30-knowledge/people/marcus-webb|Marcus]].

> [!note] Imported
> First clipped from a long article, then rewritten in my own words by the dream.`,
    },
    {
      path: '30-knowledge/accessible-forms.md', title: 'Accessible forms checklist', layer: 'semantic', type: 'concept', importance: 2, tags: ['a11y', 'web'],
      status: 'draft', confidence: 'medium', createdMin: 6 * DAY, updatedMin: DAY + 14 * 60,
      body: `# Accessible forms checklist

Written after the accessibility pass on [[40-projects/site/README|the portfolio site]].

1. Every input has a visible label that is programmatically tied to it. Placeholders are hints, not labels.
2. Errors are announced and also summarised at the top, with links to the fields.
3. Focus moves to the summary after a failed submit, and returns to the trigger when a dialog closes.
4. Required fields say so in text, not only by colour.
5. Touch targets are at least 44px.

## Still to check
- [ ] Contact form error summary on small screens
- [ ] Reduced-motion handling on the success state

[[30-knowledge/people/priya-nair|Priya]] asked for the checklist to be reused on her next project, so it belongs here rather than in the project note.`,
    },
    {
      path: '30-knowledge/speech-latency-budget.md', title: 'Speech latency budget', layer: 'semantic', type: 'concept', importance: 3, tags: ['voice', 'kokoro', 'performance'],
      provenance: 'dream', createdMin: 29 * 60, updatedMin: 29 * 60,
      body: `# Speech latency budget

A voice reply feels natural when the first audio starts in about a second. The budget I am working to:

- Speech to text: 300 ms after I stop talking
- First token from the model: 450 ms
- Text to first audio (Kokoro, warm on the GPU): 250 ms
- Slack: 200 ms

## What the benchmark showed
Kokoro on the local GPU reaches first audio under 300 ms once the model is loaded. A cold start costs about two seconds, so the daemon keeps it warm. The research session summary is in Work, and the raw numbers are in [[${jl(now, -2)}|the journal two days ago]].

## Consequences
- Stream sentences to the voice as they complete, not whole replies.
- Strip emotion tags before synthesis ([[00-core/persona]]).
- Keep the voice stack local, in line with [[30-knowledge/local-first-software]].

Project: [[40-projects/assistant/README]]. A feature that depends on this: [[50-inbox/idea-voice-capture]].`,
    },
    {
      path: '30-knowledge/trust-ladder.md', title: 'The trust ladder (T0 to T4)', layer: 'semantic', type: 'concept', importance: 4, tags: ['safety', 'autonomy'],
      provenance: 'dream', createdMin: 5 * 60 + 2, updatedMin: 5 * 60 + 2,
      body: `# The trust ladder (T0 to T4)

A way to decide how much Mira may do without asking. Each rung is an action class, and each class has a default.

1. **T0, read**: look at anything that is not private. Always allowed.
2. **T1, journal and inbox**: append a line, file a capture. Allowed, reported afterwards.
3. **T2, knowledge notes**: create or edit concept and people notes. Allowed, one commit each.
4. **T3, core and strategy**: propose a diff. Only I can apply it.
5. **T4, outward**: send, spend, invite, delete. Draft first, approve every time.

## Promotion
A rule can move up when I have approved the same kind of action many times with no regrets. Mira suggests the promotion. I decide. Nothing in T4 ever becomes automatic for money.

## Where it is written down
[[00-core/operating-rules]] holds the hard limits. The write boundary for notes is a consequence of [[10-strategy/decision-vault-as-markdown]]. How it feels in practice is described in [[00-core/persona]] and built in [[40-projects/assistant/README]].

> [!mira] Why I made this note
> You asked "what is she allowed to do?" three times this month. Now there is one place to point at.`,
    },
    {
      path: '30-knowledge/agent-briefs.md', title: 'Briefing a coding agent', layer: 'semantic', type: 'concept', importance: 3, tags: ['claude', 'process'],
      provenance: 'dream', confidence: 'medium', createdMin: 25 * DAY, updatedMin: 7 * DAY,
      body: `# Briefing a coding agent

A good brief takes five minutes and saves an hour of drift.

1. **Goal**: one sentence a stranger could check.
2. **Constraints**: stack, style, files not to touch.
3. **Definition of done**: tests, behaviour, or a screenshot.
4. **Out of scope**: the tempting thing nearby.
5. **Report**: what to say when finished or stuck.

## What I have seen
- Agents wait politely for a permission I forgot to pre-approve, so I list the commands I expect.
- Sessions that start from a linked note ask fewer questions. Hubs help: [[40-projects/atlas/README]].
- Overnight work is best when the last journal line says what to do next ([[10-strategy/deep-work-system]]).

## Related
Risky commands still wait for me, per [[30-knowledge/trust-ladder]]. The project this was learned on: [[40-projects/assistant/README]].`,
    },
    {
      path: '30-knowledge/people/dana-reyes.md', title: 'Dana Reyes', layer: 'semantic', type: 'person', importance: 4, tags: ['person', 'mentor'],
      createdMin: 90 * DAY, updatedMin: DAY + 14 * 60,
      body: `# Dana Reyes

Mentor and ex-founder. We talk about once a month, usually over a video call, and every time she asks one question that costs me a week of thinking.

## Why she matters now
She may introduce me to a seed investor she trusts, if the wedge is sharp enough. The positioning she keeps pressing on is in [[10-strategy/q4-positioning]]. Funding matters because of [[10-strategy/financial-independence]].

## Call today at 14:00
- [ ] Open with the sharper wedge: local-first tools for independent builders.
- [ ] Ask what a "yes" from an investor would look like for [[40-projects/atlas/README|Atlas]].
- [ ] Bring the beta date and the cut list ([[10-strategy/decision-atlas-beta]]).

## What she has said
- "Who would be upset if this disappeared?" See [[10-strategy/q3-positioning]].
- "Leave a clean repo and a rested head." Now part of [[00-core/values]].

Last spoke: [[${jl(now, -1)}|yesterday]].`,
    },
    {
      path: '30-knowledge/people/leo-park.md', title: 'Leo Park', layer: 'semantic', type: 'person', importance: 3, tags: ['person', 'friend', 'design'],
      createdMin: 85 * DAY, updatedMin: 12 * DAY,
      body: `# Leo Park

Designer and friend. He helps with UI polish and tells me when something looks "smart but not kind".

## Working together
- He reviewed the first pass of the Brain screens in [[40-projects/assistant/README|ai_assistant]] and pushed for calmer type and fewer borders.
- He is a good sounding board for the forms work in [[30-knowledge/accessible-forms]].
- He would take a small fee for visual work on [[40-projects/site/README|the portfolio site]] if Priya's budget allows.

## Keep in touch
We have not spoken in twelve days. I owe him a coffee and a thank-you.
- [ ] Message Leo about Saturday

I would give him the same advice I gave myself in [[20-journal/reflections/saying-yes-too-fast]]: say no early.`,
    },
    {
      path: '30-knowledge/people/priya-nair.md', title: 'Priya Nair', layer: 'semantic', type: 'person', importance: 3, tags: ['person', 'client'],
      createdMin: 70 * DAY, updatedMin: 3 * 60,
      body: `# Priya Nair

Client for [[40-projects/site/README|the portfolio site]]. Clear, kind, quick to reply, a little too good at adding "one more page".

## Preferences
- Wants short emails and a visible next step.
- Prefers Thursday calls.
- Cares about accessibility more than most clients, which is why [[30-knowledge/accessible-forms]] exists.

## Open
- [ ] Reply to her message about the final copy (a draft is waiting in the approvals queue)
- [ ] Agree what is in scope before adding pages. See [[20-journal/reflections/saying-yes-too-fast]].

## Money
Invoices go to [[30-knowledge/people/marcus-webb|Marcus]] at quarter end. She is one of the two clients that cover fixed costs in [[10-strategy/financial-independence]].`,
    },
    {
      path: '30-knowledge/people/marcus-webb.md', title: 'Marcus Webb', layer: 'semantic', type: 'person', importance: 3, tags: ['person', 'accountant'],
      createdMin: 80 * DAY, updatedMin: 10 * DAY,
      body: `# Marcus Webb

My accountant. Careful, dry, allergic to spreadsheets with merged cells.

## What he needs from me
- A clean yearly export of income and expenses, grouped by category. Atlas should produce it ([[40-projects/atlas/README]], decided in [[10-strategy/decision-atlas-beta]]).
- Invoices from [[30-knowledge/people/priya-nair|client work]] by quarter end.
- Questions in one email, not five.

## Open
- [ ] Reply about the export format
- [ ] Ask whether envelope categories map to his tax categories ([[30-knowledge/envelope-budgeting]])

His yearly review feeds [[10-strategy/financial-independence]].`,
    },
    {
      path: '30-knowledge/people/elena.md', title: 'Elena (Mom)', layer: 'semantic', type: 'person', importance: 2, tags: ['person', 'family'],
      createdMin: 118 * DAY, updatedMin: DAY,
      body: `# Elena (Mom)

Birthday is coming up. She likes flowers that are not roses and a phone call that is not about work.

## Routine
- Order flowers about four days early so they arrive on the day.
- Call in the evening, not during a block ([[10-strategy/deep-work-system]]).

## Mira's job
Remind me three days before, with the florist already open. I decide what to send. Contact details live in [[00-core/user-profile]].`,
    },

    // ------------------------------------------------------------ 40-projects
    {
      path: '40-projects/atlas/README.md', title: 'Project: Atlas (finance app)', layer: 'project', type: 'project', importance: 5, tags: ['project', 'finance'],
      createdMin: 90 * DAY, updatedMin: 5 * 60 + 20,
      body: `# Atlas

> [!note] Atlas is the finance app
> Not the graph and not the vault. A local personal-finance app that keeps everything in one SQLite file on this machine. Mira reads aggregates through a read-only connector.

## Status
Beta before December. The decision and its cut list: [[10-strategy/decision-atlas-beta]]. The latest planning meeting: [[secondbrain/atlas-planning-recap]].

## Beta scope
- [x] Cursor-based import ([[30-knowledge/plaid-sync-pattern]])
- [x] Envelope budget view ([[30-knowledge/envelope-budgeting]])
- [ ] Migrate the old database to WAL ([[30-knowledge/sqlite-wal]]). Blocked on deleting a stale backup.
- [ ] Contract tests for the importer
- [ ] Accountant export for [[30-knowledge/people/marcus-webb|Marcus]]

## Dashboard sessions
Work shows these live: \`s-migrate\` (blocked on permission) and \`s-contract-tests\` (waiting for input). Brief agents as in [[30-knowledge/agent-briefs]].

## Why it matters
Atlas is the proof point for [[10-strategy/q4-positioning]] and the engine behind [[10-strategy/financial-independence]]. Backups of its data are handled in [[40-projects/homelab/README|the home-lab]].`,
    },
    {
      path: '40-projects/assistant/README.md', title: 'Project: ai_assistant', layer: 'project', type: 'project', importance: 5, tags: ['project', 'assistant'],
      createdMin: 75 * DAY, updatedMin: 5 * 60 + 18,
      body: `# ai_assistant

This app: a local-first assistant with a room to live in, a dashboard for work and life, and a second brain she looks after.

## Pieces
- **Daemon**: runs on this PC, watches Claude Code sessions, owns the vault and the schedule.
- **Web app**: the room, the chat and these dashboards.
- **Second brain**: markdown in git, six layers, protected core and strategy ([[10-strategy/decision-vault-as-markdown]]).
- **Voice**: local speech in and out, budgeted in [[30-knowledge/speech-latency-budget]].

## Phases
1. Daemon, hooks and read-only dashboards.
2. The vault editor and the nightly dream.
3. Outward actions behind [[30-knowledge/trust-ladder|the trust ladder]].

## Dashboard sessions
\`s-daemon\` is scaffolding the health endpoint. \`s-kokoro\` finished the voice research.

## Links
Strategy: [[10-strategy/q4-positioning]]. Persona and boundaries: [[00-core/persona]], [[00-core/operating-rules]]. Feature queue: [[50-inbox/idea-voice-capture]]. Why local: [[30-knowledge/local-first-software]]. How I brief agents: [[30-knowledge/agent-briefs]]. Last benchmark: [[${jl(now, -2)}]].`,
    },
    {
      path: '40-projects/site/README.md', title: 'Project: portfolio-site', layer: 'project', type: 'project', importance: 3, tags: ['project', 'client'],
      createdMin: 55 * DAY, updatedMin: DAY + 14 * 60,
      body: `# portfolio-site

Client work for [[30-knowledge/people/priya-nair|Priya]]: a small portfolio site with a contact form and a case-study layout.

## Status
- [x] Accessibility pass (session \`s-a11y\`, done). Checklist: [[30-knowledge/accessible-forms]]
- [ ] Final copy from Priya
- [ ] Launch checklist and redirects

## Notes
Scope creep is the risk here. Anything new gets a price first, and a day to think ([[20-journal/reflections/saying-yes-too-fast]]). Visual polish: [[30-knowledge/people/leo-park|Leo]] has offered to look.

It is one of two clients that cover fixed costs ([[10-strategy/financial-independence]]).`,
    },
    {
      path: '40-projects/homelab/README.md', title: 'Project: home-lab', layer: 'project', type: 'project', importance: 2, tags: ['project', 'infra'],
      createdMin: 80 * DAY, updatedMin: 5 * DAY,
      body: `# home-lab

Certs, backups and a few self-hosted services. Quiet on purpose.

## Status
Certificates renewed early (session \`s-certs\`, idle). Nightly backups verified last Sunday.

## Why it exists
Local-first means backups are my job ([[30-knowledge/local-first-software]]). The Atlas migration relies on a verified backup before it deletes the old one ([[40-projects/atlas/README]]).

## Next
- [ ] Test a restore from cold storage
- [ ] Move certificate renewal into a monthly checklist`,
    },

    // --------------------------------------------------------------- 50-inbox
    {
      path: '50-inbox/idea-voice-capture.md', title: 'Idea: voice "remember this" capture', layer: 'inbox', type: 'source', importance: 2, tags: ['idea', 'voice'],
      status: 'draft', confidence: 'low', provenance: 'assistant', createdMin: 4 * DAY, updatedMin: 95,
      body: `Say "remember this" and she files it into the inbox. No typing, no app switching.

## Sketch
- Push-to-talk, local speech to text, one sentence of context from what is on screen.
- The note lands in the inbox as a T1 write, with the transcript attached ([[30-knowledge/trust-ladder]]).
- The nightly dream files it or asks me where it belongs.

## Open questions
- [ ] How do I mark something private by voice?
- [ ] Does the latency budget allow a spoken confirmation? ([[30-knowledge/speech-latency-budget]])

Project: [[40-projects/assistant/README]].`,
    },
    {
      path: '50-inbox/idea-wedge-metric.md', title: 'Idea: measure the wedge by weekly active builders', layer: 'inbox', type: 'source', importance: 2, tags: ['idea', 'strategy'],
      status: 'draft', confidence: 'low', provenance: 'user', createdMin: 14 * 60, updatedMin: 14 * 60,
      body: `Captured by voice yesterday: "remember this, measure the wedge by weekly active builders, not downloads."

If the positioning is right ([[10-strategy/q4-positioning]]), the number that moves first is the count of builders who open [[40-projects/atlas/README|Atlas]] in a given week. Downloads would flatter me.

- [ ] Decide whether this needs telemetry, which conflicts with local-first
- [ ] Ask [[30-knowledge/people/dana-reyes|Dana]] what she would measure`,
    },
    {
      path: '50-inbox/clip-local-first-talk.md', title: 'Clip: "Local-first, one year later"', layer: 'inbox', type: 'source', importance: 2, tags: ['clip', 'talk'],
      provenance: 'import', confidence: 'medium', createdMin: 6 * DAY, updatedMin: 95,
      body: `Clipped from a conference talk. Summary by Mira, source link kept in git.

## Three takeaways
1. Users forgive a missing feature faster than a lost file.
2. Sync conflicts are rarer than feared, if the data model is append-friendly.
3. "Works offline" sells better than "private", although they are the same thing.

## Where it belongs
Probably under [[30-knowledge/local-first-software]]. The talk agrees with the weekly review: [[${weeklyLink(now)}]]. Waiting for you to confirm the filing.`,
    },

    // -------------------------------------------------------------- federated
    {
      path: 'secondbrain/atlas-planning-recap.md', title: 'Atlas planning meeting recap (Secondbrain)', layer: 'semantic', type: 'review', importance: 3, source: 'secondbrain', tags: ['federated', 'meeting'],
      createdMin: 22 * DAY, updatedMin: 20 * DAY, provenance: 'federated',
      body: `# Atlas planning meeting recap

Imported from Secondbrain. 52 minutes, three speakers.

## Decisions
- Ship the beta before December ([[10-strategy/decision-atlas-beta]]).
- Cut multi-currency and investment tracking.
- The accountant export is a beta requirement, not a stretch.

## Action items
- [x] Cut the scope list ([[40-projects/atlas/README]])
- [ ] Contract tests before the migration lands
- [ ] Send [[30-knowledge/people/marcus-webb|Marcus]] a sample export

## Open
Backups before the old database is deleted. Owner: me.`,
    },
    {
      path: 'secondbrain/weekly-tasks.md', title: 'Weekly tasks (Secondbrain)', layer: 'semantic', type: 'review', importance: 2, source: 'secondbrain', tags: ['federated', 'tasks'],
      createdMin: 9 * DAY, updatedMin: DAY, provenance: 'federated',
      body: `# Weekly tasks

Imported from Secondbrain, read-only.

- [ ] Reply to Priya about the final copy ([[30-knowledge/people/priya-nair]])
- [ ] Contract tests outline for the importer ([[40-projects/atlas/README]])
- [ ] Home-lab restore test ([[40-projects/homelab/README]])
- [x] Renew certificates`,
    },
  ]
}

export function buildNotes(now: Date): Note[] {
  return seeds(now).map((s, i) => ({
    id: `note-${i + 1}`,
    path: s.path,
    title: s.title,
    layer: s.layer,
    type: s.type,
    status: s.status ?? 'active',
    importance: s.importance,
    confidence: s.confidence ?? 'high',
    provenance: s.provenance ?? (s.source === 'secondbrain' ? 'federated' : s.layer === 'episodic' ? 'assistant' : 'user'),
    sensitivity: s.sensitivity ?? 'normal',
    tags: s.tags ?? [],
    created: ago(now, s.createdMin),
    updated: ago(now, s.updatedMin),
    source: s.source ?? 'vault',
    ...(s.reviewDays !== undefined ? { reviewAfter: dateOnly(now, s.reviewDays) } : {}),
    ...(s.tokens !== undefined ? { contextTokens: s.tokens } : {}),
    ...(s.supersededBy ? { supersededBy: s.supersededBy } : {}),
    body: s.body,
  }))
}

export function buildProposals(now: Date): Proposal[] {
  return [
    {
      id: 'pr-q4',
      targetPath: '10-strategy/q4-positioning.md',
      title: 'Narrow the Q4 positioning to "local-first tools for independent builders"',
      rationale:
        'Four of your last five journal entries say "local-first", and Dana asked yesterday who would miss the tools. A tighter wedge answers both. The old wording stays in the Q3 note.',
      diff: [
        '@@ -7,7 +7,8 @@ ## Positioning',
        ' ',
        ' ## Positioning',
        `-${Q4_OLD}`,
        `+${Q4_NEW_1}`,
        `+${Q4_NEW_2}`,
        ' ',
        ` ${Q4_WHY_HEAD}`,
        ` ${Q4_WHY_1} See [[30-knowledge/local-first-software]].`,
      ],
      status: 'pending',
      createdAt: ago(now, 55),
      provenance: 'dream',
      evidence: [
        { path: journalPath(now, -1), title: `Journal ${dateOnly(now, -1)}` },
        { path: '30-knowledge/people/dana-reyes.md', title: 'Dana Reyes' },
        { path: '50-inbox/clip-local-first-talk.md', title: 'Clip: "Local-first, one year later"' },
      ],
    },
    {
      id: 'pr-values',
      targetPath: '00-core/values.md',
      title: 'Add "say no early" to your principles',
      rationale:
        'You wrote about saying yes too fast on two evenings this month, and both yeses cost a morning block. This turns your own words into a rule I can apply, and asks me to check what a new commitment replaces.',
      diff: [
        '@@ -13,6 +13,7 @@ ## Principles',
        ` ${V_3}`,
        ` ${V_4}`,
        ` ${V_5}`,
        '+6. Say no early. A clean no is kinder than a tired yes.',
        ' ',
        ` ${V_SHOW}`,
        ` ${V_SHOW_1}`,
        '@@ -19,3 +20,4 @@ ## How these show up',
        ` ${V_SHOW_1}`,
        '+- Before I say yes to a new commitment, Mira asks what it replaces.',
        ` ${V_SHOW_2} [[00-core/operating-rules]] has the details.`,
      ],
      status: 'pending',
      createdAt: ago(now, 52),
      provenance: 'dream',
      evidence: [
        { path: '20-journal/reflections/saying-yes-too-fast.md', title: 'Reflection: why I say yes too fast' },
        { path: journalPath(now, -1), title: `Journal ${dateOnly(now, -1)}` },
      ],
    },
    {
      id: 'pr-deepwork',
      targetPath: '10-strategy/deep-work-system.md',
      title: 'Keep calls after lunch and mornings for building',
      rationale: 'Eight of ten calls this month landed before 11:00, and those days produced the least code. Your own note says mornings are for building.',
      diff: [
        '@@ -8,5 +8,5 @@ ## Rules',
        ` ${DW_1}`,
        `-${DW_2_OLD}`,
        `+${DW_2_NEW}`,
        ` ${DW_3}`,
      ],
      status: 'approved',
      createdAt: ago(now, 4 * DAY + 300),
      decidedAt: ago(now, 3 * DAY + 120),
      commit: 'b7d8e9f',
      provenance: 'dream',
      evidence: [
        { path: weeklyPath(now), title: `Weekly review ${dateOnly(now, -5)}` },
        { path: '30-knowledge/people/dana-reyes.md', title: 'Dana Reyes' },
      ],
    },
    {
      id: 'pr-weekend',
      targetPath: '00-core/operating-rules.md',
      title: 'Allow a gentle weekend check-in',
      rationale: 'You answered two weekend messages last month within minutes, so a Sunday evening nudge might be welcome.',
      diff: [
        '@@ -20,4 +20,5 @@ ## Always',
        ` ${OR_HEAD}`,
        ` ${OR_1}`,
        ` ${OR_2}`,
        '+- On Sunday evening, send one short check-in about the week ahead.',
      ],
      status: 'rejected',
      createdAt: ago(now, 12 * DAY),
      decidedAt: ago(now, 12 * DAY - 40),
      provenance: 'dream',
      evidence: [{ path: '00-core/user-profile.md', title: 'About me' }],
    },
  ]
}

export function buildMemory(now: Date): MemoryEntry[] {
  return [
    {
      id: 'mem-triage', kind: 'triage', at: ago(now, 95), title: 'Inbox triage',
      summary: 'Read 3 new captures. Filed 1, linked 1 to a project and left 1 for you to decide.',
      stats: { captures: 3, filed: 1, linked: 1, left: 1 }, costUsd: 0.02, commit: '7c9d1e2', durationSec: 24,
      changes: [
        { path: '50-inbox/clip-local-first-talk.md', title: 'Clip: "Local-first, one year later"', kind: 'filed', note: 'Suggested home: Local-first software. Waiting for your confirmation.' },
        { path: '50-inbox/idea-voice-capture.md', title: 'Idea: voice "remember this" capture', kind: 'updated', note: 'Linked to the ai_assistant project hub.' },
      ],
    },
    {
      id: 'mem-dream', kind: 'dream', at: ago(now, 60 * 5), title: 'Nightly dream',
      summary: 'Compressed yesterday into one journal entry, merged 2 duplicate concept notes, wrote 1 new note and queued 2 proposals for your morning review.',
      stats: { created: 1, updated: 3, merged: 2, proposals: 2 }, costUsd: 0.08, commit: 'a1b2c3d', durationSec: 412,
      changes: [
        { path: '30-knowledge/trust-ladder.md', title: 'The trust ladder (T0 to T4)', kind: 'created', note: 'You asked what she may do three times this month.' },
        { path: journalPath(now, -1), title: `Journal ${dateOnly(now, -1)}`, kind: 'updated', note: 'Compressed to the day\'s decisions.' },
        { path: '30-knowledge/local-first-software.md', title: 'Local-first software', kind: 'updated', note: 'Linked the clipped talk.' },
        { path: '40-projects/atlas/README.md', title: 'Project: Atlas (finance app)', kind: 'updated', note: 'Refreshed the status block from the sessions.' },
        { path: '30-knowledge/sqlite-wal.md', title: 'SQLite WAL mode', kind: 'merged', note: 'Absorbed "WAL quick notes".' },
        { path: '30-knowledge/plaid-sync-pattern.md', title: 'Cursor-based transaction sync', kind: 'merged', note: 'Absorbed "transaction cursor".' },
        { path: '10-strategy/q4-positioning.md', title: 'Q4 positioning', kind: 'proposed', note: 'Narrow the wedge. Waiting for you.' },
        { path: '00-core/values.md', title: 'Values and principles', kind: 'proposed', note: 'Add "say no early". Waiting for you.' },
      ],
    },
    {
      id: 'mem-capture', kind: 'capture', at: ago(now, 14 * 60), title: 'Captured by voice',
      summary: 'You said "remember this: measure the wedge by weekly active builders". Filed to the inbox untouched until the dream.',
      stats: { created: 1 }, costUsd: 0, commit: '3f4a5b6', durationSec: 3,
      changes: [{ path: '50-inbox/idea-wedge-metric.md', title: 'Idea: measure the wedge by weekly active builders', kind: 'created', note: 'Transcript attached.' }],
    },
    {
      id: 'mem-dream-1', kind: 'dream', at: ago(now, 29 * 60), title: 'Nightly dream',
      summary: 'Found the Kokoro numbers in three places and consolidated them into one note.',
      stats: { created: 1, updated: 2, links: 4 }, costUsd: 0.07, commit: '9e8d7c6', durationSec: 366,
      changes: [
        { path: '30-knowledge/speech-latency-budget.md', title: 'Speech latency budget', kind: 'created' },
        { path: journalPath(now, -2), title: `Journal ${dateOnly(now, -2)}`, kind: 'updated', note: 'Compressed.' },
        { path: '40-projects/assistant/README.md', title: 'Project: ai_assistant', kind: 'updated', note: 'Linked the new note.' },
      ],
    },
    {
      id: 'mem-lint', kind: 'lint', at: ago(now, 3 * DAY), title: 'Vault lint',
      summary: 'Checked 37 notes. No broken links, no orphans, 2 notes past their review date. Fixed 2 frontmatter typos and left the review dates for you.',
      stats: { checked: 37, stale: 2, fixed: 2 }, costUsd: 0.01, commit: '5a6b7c8', durationSec: 9,
      changes: [
        { path: '30-knowledge/people/dana-reyes.md', title: 'Dana Reyes', kind: 'updated', note: 'Fixed a tag typo.' },
        { path: '30-knowledge/people/leo-park.md', title: 'Leo Park', kind: 'updated', note: 'Normalised the tags.' },
      ],
    },
    {
      id: 'mem-dream-3', kind: 'dream', at: ago(now, 4 * DAY + 300), title: 'Nightly dream',
      summary: 'Noticed that calls cluster before 11:00 and queued a proposal to move them after lunch.',
      stats: { updated: 2, proposals: 1 }, costUsd: 0.06, commit: '2b3c4d5', durationSec: 301,
      changes: [
        { path: '10-strategy/deep-work-system.md', title: 'Deep-work system', kind: 'proposed', note: 'Calls after 13:00. You approved it three days ago.' },
        { path: '30-knowledge/agent-briefs.md', title: 'Briefing a coding agent', kind: 'updated', note: 'Added the permission lesson.' },
      ],
    },
    {
      id: 'mem-weekly', kind: 'weekly_review', at: ago(now, 60 * 24 * 5), title: 'Weekly review',
      summary: 'Q4 positioning is about 40% done. Home-lab and the site were quiet for six days. Wrote 3 reflections and listed 6 open loops.',
      stats: { reflections: 3, openLoops: 6, stale: 2 }, costUsd: 0.21, commit: 'e4f5a6b', durationSec: 640,
      changes: [
        { path: weeklyPath(now), title: `Weekly review ${dateOnly(now, -5)}`, kind: 'created' },
        { path: '40-projects/homelab/README.md', title: 'Project: home-lab', kind: 'updated', note: 'Marked quiet, not stale.' },
      ],
    },
    {
      id: 'mem-attach', kind: 'capture', at: ago(now, 9 * DAY), title: 'Attached Secondbrain (read-only)',
      summary: 'Mounted your Secondbrain workspace as a federated source. 2 notes indexed. Nothing was copied into the vault and nothing can be written back.',
      stats: { indexed: 2 }, costUsd: 0, commit: 'd4e5f60', durationSec: 11,
      changes: [
        { path: 'secondbrain/atlas-planning-recap.md', title: 'Atlas planning meeting recap (Secondbrain)', kind: 'indexed' },
        { path: 'secondbrain/weekly-tasks.md', title: 'Weekly tasks (Secondbrain)', kind: 'indexed' },
      ],
    },
  ]
}
