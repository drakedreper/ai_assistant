# Spike (d): draft email to Anthropic about personal, subscription-based use

Status: draft for the user to review, edit and send. Not sent. Date: 2026-10-31.

Purpose: settle the grey zone in [ADR 0001](../docs/adr/0001-claude-auth-modes.md). The legal page says third parties may not offer claude.ai login or route requests through plan credentials, but also that this does not stop an end user signing in to the unmodified Claude Code binary. It does not say whether a self-built local app that drives that binary programmatically, for one person's own use, is on the permitted side, and it says plan limits assume "ordinary, individual usage". It points ambiguous cases to Anthropic, so ask.

Before sending
- Re-copy the quoted text below from the live page, https://code.claude.com/docs/en/legal-and-compliance (and the note at https://code.claude.com/docs/en/agent-sdk/overview), because the wording may have changed since the research read it. The quotes below are as the research recorded them.
- Use the contact route the legal page links for sales or commercial questions. No address is filled in here on purpose; do not guess one.
- Fill in the bracketed parts. Do not include API keys, tokens or session identifiers.
- The default in the app is an API key, so no answer is needed to proceed. The answer decides whether the optional `local-login` mode may be used for scheduled and background jobs.

---

Subject: Question about personal use of Claude Code with a subscription from a self-built local app

Hello,

I am an individual developer building a personal assistant for my own use on my own Windows 11 PC. Before I rely on my subscription for it, I would like to confirm that what I plan is permitted.

What the app is
- A small local daemon (Node and TypeScript) running on my PC and bound to the loopback interface only. It is for me alone: no other users, no hosting, no distribution, and no plan to share it.
- It uses the Claude Agent SDK (TypeScript), pinned to a version, to run a chat session and a few scheduled jobs (a morning briefing and a nightly note-consolidation job). It also observes my own terminal Claude Code sessions through hooks and `claude agents --json`.
- In the mode I am asking about, the SDK is pointed at the `claude` binary that I installed myself, unmodified, and that I signed in to myself with my own [plan name] subscription. The app never reads, copies, stores or forwards my OAuth credentials or session tokens, and I do not offer Claude.ai login to anyone.
- The default mode of the app uses an API key instead. I would like to know whether the subscription mode is also acceptable.

Expected usage
- One interactive chat session and occasional short turns during the day; one scheduled briefing job each morning; one consolidation job each night; at most [two or three] concurrent sessions, including my own terminal work. It is not a continuous or high-volume workload. [Adjust to what is true.]

The text I am asking about
The legal and compliance page says: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens." It also says this does not prevent an end user from signing in to the unmodified Claude Code binary with their own subscription, and that plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK". The Agent SDK overview says developers should use API key authentication unless previously approved.

My questions
1. Is it permitted for me, as the end user, to run a self-built local application for my own personal use that drives my own installed and logged-in Claude Code binary through the Agent SDK, using my subscription, provided it never handles my credentials?
2. If yes, does a usage pattern like the one above (interactive chat plus a few scheduled jobs) count as "ordinary, individual usage", or is there a limit or a pattern I should avoid, for example unattended scheduled jobs?
3. Are there differences in how my data is handled between using my subscription and using an API key that matter for personal email, finance and notes content I might include in prompts? (I understand the consumer and commercial terms differ and want to be sure which applies.)
4. If the answer is no, or only partly yes, is an API key the correct route for this kind of personal app?

If it helps, I can share a short architecture description. Thank you for your time.

Best regards,
[Your name]
[Account email on the subscription]
[Plan: Pro, Max or other]

---

After the answer
- Record the reply and its date in `spikes/results/` (not committed) and update ADR 0001 with the outcome.
- If the answer is yes: `local-login` can be offered for scheduled jobs as well, still personal-use only and never shipped to others.
- If it is no or unclear: keep every daemon-launched session on `ANTHROPIC_API_KEY`, and keep `local-login` limited to the user's own interactive terminal use or remove it.
