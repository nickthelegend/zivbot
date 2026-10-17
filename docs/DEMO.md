# Demo video script (≈3 min)

Before you record:

- Reset to a fresh user: clear `localStorage` in the app, or open a private window.
- Make sure FalkorDB and ZivBot are running (`npm run dev`).
- Make sure Codex works: `ZIV_CODEX_MODEL` is set in `.env`.
- Use a 1440×900 window and dark mode.

| Time | On screen | Say |
|---|---|---|
| 0:00 | Empty ZivBot, Ziv says hi | "This is ZivBot. It's an agent-native assistant: it connects my apps *and* my AI subscriptions (Codex, Claude Code, Cursor, OpenCode) into one FalkorDB graph, and its agents, the dots, act on that graph." |
| 0:12 | Type your name, pick **A · Ziv** | "Onboarding feels like GrokBot, but everything Ziv learns goes into a graph. One isolated FalkorDB graph per user." |
| 0:22 | Click **Connect** on the Lumen Labs workspace. Scout and Forge appear | "A synthetic company: Gmail, Calendar, Slack, Notion, Linear and a real git repo. It took 300ms to ingest: 20 people, 11 systems, decisions, tickets. Ziv also brings in two specialist dots." |
| 0:35 | **Suggest a first task** | "Triage is graph work. A P1 on payments-api hits two dependent systems and $246k of customer ARR. Kate at Brightwave has asked three times. Two decisions are waiting on me, and there's a calendar clash." |
| 0:55 | Click **Show path** | "Every answer has a path: the exact Cypher, the timings, and the subgraph it used. No black box." |
| 1:10 | Type *Fix LUM-142 and LUM-139* | "Ziv doesn't code. It messages Forge, the engineering dot. Forge pulls Priya's N+1 diagnosis from Slack and the repo that implements payments-api, then scores my subscriptions with one Cypher query." |
| 1:30 | Approval card: Codex vs Claude Code vs Grok, with reasons | "Nothing runs without me. I approve Codex." |
| 1:35 | Open Forge's chat: live run log, then *3 passed* | "That's real Codex on my machine, on a branch. Tests go from 1 of 3 to 3 of 3 passing. The run is written back to the graph: Run, RESOLVES, Ticket." |
| 2:05 | Click **Draft the update to Kate** | "Because the fix is in the graph, the reply already knows the invoice bug is fixed. Approve and send." |
| 2:20 | Ask *why did we move to Stripe Billing?* then *what breaks if billing-db goes down?* | "Decisions trace back to the Slack message and the Notion RFC. The blast radius is a 4-hop DEPENDS_ON traversal." |
| 2:40 | Open the **Graph** tab, size by PageRank, run a sample in the Cypher console | "PageRank, label propagation and betweenness run on the collaboration graph ZivBot derives." |
| 2:50 | Desktop app plus the Android app paired by QR | "It ships as a desktop app, where the dots run on their own computer, and an Android app that pairs over Wi-Fi. There's also an MCP server, so Codex or Claude can query the same graph." |
| 3:00 | End card | "ZivBot: connect everything, act on the graph, show the path." |
