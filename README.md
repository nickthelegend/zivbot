<p align="center"><img src="docs/hero.jpg" alt="ZivBot — dots that act on your graph" width="100%"></p>

# ZivBot

**Agent-native dots on a FalkorDB graph.** Connect your apps *and your AI subscriptions* (Codex, Claude Code, Cursor, OpenCode, Grok, Antigravity). ZivBot maps all of it into one graph per user. Its personal agents, the **dots**, use that graph to decide what matters, talk to each other, and act through the right coding agent. Every answer comes with the Cypher path behind it.

> 🏁 **Graph Hacks: Context for AI Agents** (WeMakeDevs × FalkorDB)
> **Track:** Agents That Act on Connected Data (primary). It also covers Agent Memory and Coordination: per-user graphs, episodic/semantic/procedural memory, and dot-to-dot handoffs.
> **Demo video:** _link_ · **Live:** _link_ · **Built in:** Oct 15–18, 2026

<p align="center"><img src="docs/screenshots/chat.png" width="880" alt="Ziv triaging from the graph"></p>

| Show path: the Cypher behind every answer | A real Codex run, picked by graph routing |
|---|---|
| <img src="docs/screenshots/trace.png" alt="Trace drawer"> | <img src="docs/screenshots/forge-run.png" alt="Forge running Codex"> |
| **Insights: bus factor, single points of failure, who's waiting** | **@-mention dots and plugins** |
| <img src="docs/screenshots/insights.png" alt="Insights"> | <img src="docs/screenshots/mentions.png" alt="Mentions"> |
| **FalkorDB algorithms as tools** | **The live graph model (Schema)** |
| <img src="docs/screenshots/algorithms.png" alt="Algorithms"> | <img src="docs/screenshots/schema.png" alt="Schema"> |
| **Your graph + Cypher console** | **Connect Apps: 28 connectors and your AI subscriptions** |
| <img src="docs/screenshots/graph.png" alt="Graph explorer"> | <img src="docs/screenshots/connect.png" alt="Connect Apps"> |

---

## Why a graph

The questions a chief of staff gets are never about one record:

| Question | Hops in the graph |
|---|---|
| *What should I handle first?* | Thread → sender → Org (ARR) · Ticket → System ← DEPENDS_ON\* ← System ← USES ← Customer |
| *Who knows payments-api?* | System ← IMPLEMENTS ← Repo ← IN_REPO ← File ← TOUCHES ← Commit → Person, plus Docs, Tickets, Projects, chat |
| *What breaks if billing-db goes down?* | `(:System)-[:DEPENDS_ON*1..4]->(billing-db)`, then customers, projects and open tickets on that radius |
| *Why did we move to Stripe?* | Decision → DECIDED_BY / APPROVED_BY → Person; Decision → SOURCE → Slack message + Notion RFC |
| *Which agent should fix this?* | Agent ← EXECUTED_BY ← Run → WORKED_ON → System (and its neighbours), quota state, Procedure → PREFERS → Agent |
| *Anything about the portal being slow?* | vector search over `:Memorable(emb)` → one hop to the tickets, people and customers each hit is about |
| *What's risky?* | `algo.betweenness` over DEPENDS_ON, `DEPENDS_ON*1..5` dependents + customer ARR, knowledge share per critical system |

The graph does real work in ZivBot (hackathon rule 3). Everything lives in FalkorDB and nowhere else:

- connected data
- chat history
- agent memory
- approvals
- runs
- tool registry
- provenance

Take FalkorDB away and nothing works.

## What it does

1. **Onboarding.** Ziv asks your name, you name it, and you connect a workspace.
2. **Connect everything.** Choose from 28 connectors in the *Connect Apps* catalog. They fall into four groups:
   - **No key:** public GitHub, local git repos, RSS, Hacker News, iCal feeds, local docs, Web/Wikipedia, any MCP server.
   - **Your AI subscriptions:** Codex, Claude Code, Cursor, OpenCode, Grok and Antigravity, detected on your computer.
   - **API key:** Gmail + Calendar, Slack, Notion, Linear, GitHub (private), Jira, Sentry, Stripe, HubSpot, Vercel, Firecrawl, Telegram, Discord. See [`TODO-KEYS.md`](TODO-KEYS.md).
   - **Demo:** the **Lumen Labs** synthetic workspace (mail, calendar, Slack, Notion, Linear and a real git repo).
3. **Triage from the graph.** Threads waiting on you are ranked by customer ARR and sender PageRank. P1/P2 tickets come with their blast radius and the ARR at risk. Pending decisions and calendar clashes are included too.
4. **Act through your agents.** "Fix LUM-142 and LUM-139":
   - Ziv hands the job to **Forge**, the engineering dot.
   - Forge pulls the diagnosis already in Slack and mail, plus the implementing repo and its authors, from the graph.
   - A graph query scores your installed agents.
   - You approve, and the agent runs headlessly on a branch. The tests run, and the result is written back as `(:Run)-[:RESOLVES]->(:Ticket)`.
   - If an agent hits its quota, the run is handed to the next-best agent.
5. **@-mention anything.** `@Forge fix LUM-142` hands the job to Forge. `@Hacker News FalkorDB` runs that plugin's tool. Mentions become `MENTIONS` edges in the graph.
6. **Semantic memory (GraphRAG).** Every message, mail, doc, ticket and decision gets a vector in **one FalkorDB vector index**. Fuzzy questions run a vector search, then follow the graph from each hit to what it's about.
7. **Insights.** One tab shows:
   - knowledge risk (bus factor on critical systems)
   - single points of failure (`algo.betweenness` over `DEPENDS_ON` plus the ARR riding on them)
   - who's waiting on you
   - who's overloaded
   - working groups (label propagation)
   - what changed in 24 hours (every node carries `firstSeen`/`lastSeen`)

   The background loop watches these too.
8. **Graph algorithms as agent tools.** `run_algorithm` gives every dot (and any MCP client) FalkorDB's `pageRank`, `betweenness`, `HarmonicCentrality`, `labelPropagation`, `WCC`, `BFS`, and weighted `SPpaths`, where collaboration strength becomes the edge cost for a "warm intro" path. Labels and relationships are allow-listed against the live schema. The **Algorithms** tab runs them visually (size = score, colour = group), and the **Schema** tab draws the live graph model with every index.
9. **Rebalance work.** "Who should take LUM-139?" ranks people by what they've done on the affected systems (commits, docs, past tickets) minus their load (open tickets, meetings), and drafts the move. Approving rewires `ASSIGNED_TO` and keeps a `PREVIOUSLY_ASSIGNED_TO` trail.
10. **⌘K.** Jump to any dot or group (⌘1–⌘9), or search the whole graph.
11. **Decision stakes.** "Help me decide" lays out the decision's source trail and everything it touches before you choose. Then the dot records the choice and drafts the follow-ups.
12. **Dots talk to each other.** "Messaged Forge" and "2 messages with Ziv" chips open the dot-to-dot exchange. Group chats route to the dots whose roles fit. All dots share one graph memory.
13. **Show the path.** Under every answer, **Show path** opens the exact Cypher run (with timings, row counts and the dot that ran it) and the subgraph the answer used.
14. **Works while you're away.** A background loop re-runs triage and only speaks up when what needs you changes. Finished runs report back with test results.
15. **Remember.** Say "remember that I prefer Codex for backend fixes": it becomes a `:Procedure` that `PREFERS` Codex, and the router weighs it on every routing decision.

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    W[Web app<br/>React] --- D[Desktop<br/>Electron] --- M[Android<br/>Expo]
  end
  subgraph Server[ZivBot server · Node + Hono]
    A[Dots<br/>LLM tool loop / graph planner] --> T[Graph tools<br/>traced Cypher]
    A <--> X[Dot ↔ dot exchanges]
    C[Connectors 28] --> I[Ingest + entity linking]
    F[Fleet router + runner] --> CLI[(codex / claude / cursor /<br/>opencode / grok / agy)]
    P[Proactive loop]
    MCP[MCP server] --> T
  end
  W & D & M -- REST + SSE --> A
  T & I & F & P --> G[(FalkorDB<br/>one graph per user)]
  ext[Claude Desktop / Codex / Cursor] -- MCP --> MCP
```

- **One graph per user** (`ziv_<userId>`), using FalkorDB's multigraph tenancy, plus a small `ziv_registry` graph.
- **Traced queries.** Every Cypher statement goes through `UserGraph.q()`. During a turn, an `AsyncLocalStorage` trace collects each query (label, Cypher, params, ms, rows) and every node uid the results touched. That becomes an `(:Answer)-[:USED]->(node)` provenance subgraph.
- **Brain.** Any OpenAI-compatible endpoint with tool calling works (OpenRouter's free models by default). Without a key, the **graph planner** maps intents to the same tools, so the app fully works with no LLM.
- **MCP both ways.** ZivBot *consumes* any MCP server, whose tools become `:Tool` nodes the dot finds with `find_tools`. ZivBot also *is* an MCP server (`npm run mcp`), so Codex, Claude Code and Cursor can query your graph.

## Graph data model

```mermaid
graph LR
  Person -->|MEMBER_OF| Team
  Person -->|WORKS_AT| Org
  Person -->|WORKS_ON / OWNS| Project
  Project -->|USES| System
  Project -->|BLOCKED_BY| Project
  System -->|DEPENDS_ON| System
  Org -->|USES| System
  Repo -->|IMPLEMENTS| System
  File -->|IN_REPO| Repo
  File -->|IMPORTS| File
  Commit -->|TOUCHES| File
  Commit -->|AUTHORED_BY| Person
  Ticket -->|AFFECTS| System
  Ticket -->|FOR| Org
  Ticket -->|ASSIGNED_TO| Person
  Email -->|FROM / TO| Person
  Email -->|IN_THREAD| Thread
  Email -->|MENTIONS| Ticket
  Person -->|ATTENDS| Event
  Person -->|POSTED| ChatMessage -->|IN| Channel
  Person -->|OWNS| Doc
  Decision -->|DECIDED_BY / APPROVED_BY / AWAITS| Person
  Decision -->|SOURCE| ChatMessage
  Decision -->|ABOUT| Project
  Run -->|EXECUTED_BY| Agent
  Run -->|WORKED_ON| System
  Run -->|RESOLVES| Ticket
  Run -->|CHANGED| File
  Procedure -->|PREFERS| Agent
  Fact -->|ABOUT| Person
  Tool -->|PROVIDED_BY| Connector
  Dot -->|MEMBER_OF| Conversation
  Episode -->|IN| Conversation
  Episode -->|NEXT| Episode
  Episode -->|MENTIONS| System
  Answer -->|USED| Ticket
  Answer -->|DELEGATED_TO| Answer
```

| Layer | Labels |
|---|---|
| Connected data | `Person` `Team` `Org` `Project` `System` `Repo` `File` `Commit` `Ticket` `Email` `Thread` `Event` `Doc` `ChatMessage` `Channel` `Decision` |
| Agent fleet | `Agent` (a subscription/CLI) · `Run` · `Tool` · `Connector` |
| Memory | `Dot` · `Conversation` (direct / group / exchange) · `Episode` (episodic) · `Fact` (semantic) · `Procedure` (procedural) · `Answer` (provenance) · `Draft` (approvals) · `Notice` |

- **Identity across apps.** Every node has a `uid`. Every entity also carries `:Searchable` with a `search` field, so **one full-text index** covers all labels. People are matched across Gmail, Slack, Linear, GitHub and git by email, then by name (`upsertPeople`).
- **Entity linking.** Free text (mail, chat, docs, commits, even chat with the dots) is scanned against a dictionary built *from the graph* (names, aliases, ticket keys) to add `MENTIONS` edges. Anything one connector ingests becomes linkable by every other connector.
- **Derived structure** is recomputed after each sync (`server/analytics.ts`):
  - `(:Person)-[:COLLABORATES {weight}]->(:Person)` from shared mail, meetings, projects, channels and files.
  - `Person.rank` from `algo.pageRank`.
  - `Person.community` from `algo.labelPropagation`.
  - `Person.broker` from `algo.betweenness`.
  - `System.criticality` from PageRank over `DEPENDS_ON`.

## The Cypher the product depends on

All of these are in `server/tools.ts`, `server/fleet.ts` and `server/analytics.ts`, and you can watch them run live in the trace drawer.

**Blast radius** — what breaks if a system goes down:
```cypher
MATCH p = (d:System)-[:DEPENDS_ON*1..4]->(s:System {uid:$u})
RETURN d.uid AS uid, d.name AS name, min(length(p)) AS hops ORDER BY hops
```
```cypher
UNWIND $all AS u MATCH (o:Org {kind:'customer'})-[:USES]->(:System {uid:u})
WITH DISTINCT o RETURN sum(o.arr) AS arr
```

**Triage** — open incidents with dependents and customers at risk:
```cypher
MATCH (t:Ticket {status:'open'})-[:AFFECTS]->(s:System) WHERE t.priority IN ['P1','P2']
OPTIONAL MATCH (t)-[:FOR]->(o:Org)
OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(a:Person)
OPTIONAL MATCH (dep:System)-[:DEPENDS_ON*1..3]->(s)
OPTIONAL MATCH (cust:Org {kind:'customer'})-[:USES]->(used:System) WHERE used = s OR used = dep
RETURN t.key, t.title, t.priority, collect(DISTINCT s.name) AS systems, a.name AS assignee,
       count(DISTINCT dep) AS dependents, collect(DISTINCT cust.name) AS customers, sum(DISTINCT coalesce(cust.arr,0)) AS arrAtRisk
```

**Who knows X** — six signals, weighted and merged. Commits:
```cypher
MATCH (x {uid:$u}) MATCH (p:Person)<-[:AUTHORED_BY]-(c:Commit)-[:TOUCHES]->(f:File)
WHERE f = x OR (f)-[:IN_REPO]->(x) OR (f)-[:IN_REPO]->(:Repo)-[:IMPLEMENTS]->(x)
RETURN p.uid, p.name, count(DISTINCT c) AS n
```

**Agent routing** — pick the subscription for a job:
```cypher
MATCH (a:Agent)
OPTIONAL MATCH (a)<-[:EXECUTED_BY]-(r:Run)-[:WORKED_ON]->(s:System) WHERE s.uid IN $systems
WITH a, collect(r) AS here
OPTIONAL MATCH (a)<-[:EXECUTED_BY]-(r2:Run)-[:WORKED_ON]->(:System)-[:DEPENDS_ON]-(n:System) WHERE n.uid IN $systems
WITH a, here, collect(DISTINCT r2) AS near
OPTIONAL MATCH (a)<-[:EXECUTED_BY]-(r3:Run) WHERE r3.status IN ['succeeded','failed']
WITH a, here, near, collect(r3) AS all
OPTIONAL MATCH (p:Procedure)-[pref:PREFERS]->(a)
RETURN a.name, a.installed, coalesce(a.limitedUntil,0) AS limitedUntil,
       size([x IN here WHERE x.status='succeeded']) AS wins, size([x IN here WHERE x.status='failed']) AS losses,
       size([x IN near WHERE x.status='succeeded']) AS nearWins, sum(CASE WHEN pref IS NULL THEN 0 ELSE pref.weight END) AS preference
```

**Decision trail** — trace a decision back to its source:
```cypher
MATCH (d:Decision) WHERE d.uid IN $ids OR (d)-[:ABOUT]->({uid:$x})
OPTIONAL MATCH (d)-[:DECIDED_BY]->(by:Person) OPTIONAL MATCH (d)-[:APPROVED_BY]->(ap:Person)
OPTIONAL MATCH (d)-[:SOURCE]->(src)
RETURN d.text, d.status, by.name, ap.name, collect(DISTINCT {name: src.name, source: src.source}) AS sources
```

**How are A and B connected:**
```cypher
MATCH p = (a {uid:$a})-[*1..4]-(b {uid:$b})
WHERE none(r IN relationships(p) WHERE type(r) IN ['COLLABORATES','IN_THREAD','BY'])
  AND none(n IN nodes(p) WHERE n:Episode OR n:Answer)
RETURN [n IN nodes(p) | n.name], [r IN relationships(p) | type(r)], length(p) AS hops ORDER BY hops LIMIT 3
```

**Graph algorithms:**
```cypher
CALL algo.pageRank('Person', 'COLLABORATES') YIELD node, score SET node.rank = score
CALL algo.labelPropagation({nodeLabels:['Person'], relationshipTypes:['COLLABORATES']}) YIELD node, communityId SET node.community = communityId
CALL algo.betweenness({nodeLabels:['Person'], relationshipTypes:['COLLABORATES']}) YIELD node, score SET node.broker = score
CALL algo.pageRank('System', 'DEPENDS_ON') YIELD node, score SET node.criticality = score
```

**Semantic memory: vector search, then graph expansion:**
```cypher
CREATE VECTOR INDEX FOR (n:Memorable) ON (n.emb) OPTIONS {dimension: 384, similarityFunction: 'cosine'}
CALL db.idx.vector.queryNodes('Memorable', 'emb', $k, vecf32($v)) YIELD node, score
UNWIND $uids AS u MATCH (n {uid: u})-[r]-(m) WHERE m:Person OR m:System OR m:Org OR m:Ticket OR m:Decision
RETURN u, type(r), m.name
```

**Single points of failure:**
```cypher
CALL algo.betweenness({nodeLabels: ['System'], relationshipTypes: ['DEPENDS_ON']}) YIELD node, score
MATCH (s:System) OPTIONAL MATCH (d:System)-[:DEPENDS_ON*1..5]->(s)
WITH s, collect(DISTINCT d) AS deps UNWIND [s] + deps AS x
OPTIONAL MATCH (o:Org {kind:'customer'})-[:USES]->(x)
RETURN s.name, size(deps) AS dependents, collect(DISTINCT o.name) AS customers
```

**Knowledge risk (bus factor):**
```cypher
MATCH (s:System) WHERE s.tier IN ['critical','high']
OPTIONAL MATCH (a:Person)<-[:AUTHORED_BY]-(:Commit)-[:TOUCHES]->(:File)-[:IN_REPO]->(:Repo)-[:IMPLEMENTS]->(s)
WITH s, collect(a.uid) AS commits
OPTIONAL MATCH (s)<-[:ABOUT]-(:Doc)<-[:OWNS]-(b:Person)
WITH s, commits, collect(b.uid) AS docs
OPTIONAL MATCH (s)<-[:AFFECTS]-(:Ticket)-[:ASSIGNED_TO]->(c:Person)
RETURN s.name, commits, docs, collect(c.uid) AS tickets
```

**Decision stakes:**
```cypher
MATCH (d:Decision {uid:$u})-[:ABOUT]->(x)
OPTIONAL MATCH (x)<-[:BLOCKED_BY]-(blocked:Project)
OPTIONAL MATCH (x)-[:USES|AFFECTS|PART_OF*1..2]-(s:System)
OPTIONAL MATCH (s)<-[:DEPENDS_ON*0..3]-(:System)<-[:USES]-(o:Org {kind:'customer'})
RETURN collect(DISTINCT blocked.name), collect(DISTINCT s.name), collect(DISTINCT o.name)
```

**Algorithms as tools** (from `server/algorithms.ts`):
```cypher
CALL algo.pageRank('System', 'DEPENDS_ON') YIELD node, score
CALL algo.HarmonicCentrality({nodeLabels:['Person'], relationshipTypes:['COLLABORATES']}) YIELD node, score
CALL algo.WCC({nodeLabels:['System'], relationshipTypes:['DEPENDS_ON']}) YIELD node, componentId
MATCH (s {uid:$src}) CALL algo.BFS(s, 3, 'DEPENDS_ON') YIELD nodes
MATCH (s {uid:$src}), (t {uid:$dst})
CALL algo.SPpaths({sourceNode: s, targetNode: t, relTypes: ['COLLABORATES'], weightProp: 'cost', maxLen: 6, pathCount: 3}) YIELD path, pathWeight
```

**Rebalance: knowledge minus load:**
```cypher
MATCH (t:Ticket {uid:$u})-[:AFFECTS]->(s:System) MATCH (p:Person)
OPTIONAL MATCH (p)<-[:AUTHORED_BY]-(c:Commit)-[:TOUCHES]->(:File)-[:IN_REPO]->(:Repo)-[:IMPLEMENTS]->(s)
…
OPTIONAL MATCH (p)<-[:ASSIGNED_TO]-(open:Ticket {status:'open'})
OPTIONAL MATCH (p)-[:ATTENDS]->(e:Event) WHERE e.start > $now AND e.start < $soon
RETURN p.name, commits, docs, tickets, count(DISTINCT open) AS load, count(DISTINCT e) AS meetings
```

**Full-text search across every label:**
```cypher
CALL db.idx.fulltext.queryNodes('Searchable', $q) YIELD node, score
```

**Memory** — what applies to this turn, from any dot:
```cypher
MATCH (e:Episode)-[:MENTIONS]->(x) WHERE x.uid IN $about AND NOT (e)-[:IN]->(:Conversation {uid:$conv})
OPTIONAL MATCH (e)-[:BY]->(d:Dot) RETURN e.role, e.text, d.name ORDER BY e.at DESC LIMIT 5
```

**Provenance:**
```cypher
MATCH (a:Answer {uid:$a}) UNWIND $touched AS x MATCH (n {uid:x}) MERGE (a)-[:USED]->(n)
```

## Run it

**Requirements:** Node 20+ and Docker. Coding-agent CLIs are optional; ZivBot detects whichever you have.

```bash
docker run -d --name zivbot-falkordb -p 6379:6379 -p 3000:3000 falkordb/falkordb:latest
```
```bash
npm install
```
```bash
cp .env.example .env
```
```bash
npm run dev
```

Then open **http://localhost:5173**. The API runs on 8787, and the FalkorDB Browser on http://localhost:3000. Everything in one go with Docker:

```bash
docker compose up -d --build
```

Configuration (`.env`):

| Var | What |
|---|---|
| `FALKORDB_URL` | `redis://localhost:6379` (FalkorDB Cloud works too, with `FALKORDB_USERNAME`/`PASSWORD`) |
| `ZIV_LLM_BASE_URL` / `ZIV_LLM_API_KEY` / `ZIV_LLM_MODEL` | any OpenAI-compatible endpoint with tool calling; `OPENROUTER_API_KEY` alone also works (free model by default). `ZIV_LLM=off` forces the graph planner |
| `ZIV_CODEX_MODEL`, `ZIV_OPENCODE_MODEL` | model pins for dispatched coding agents |
| `ZIV_PROACTIVE_MS` | how often dots scan the graph on their own (0 = off) |

**Demo script** (about 3 minutes):

1. Type your name and pick "Ziv".
2. Click **Connect** on the Lumen Labs workspace.
3. Choose **Suggest a first task**.
4. Click **Show path** on the answer.
5. Ask "Fix LUM-142 and LUM-139", then approve **Codex**. Watch the live run in Forge's chat, where the tests go from 1/3 to 3/3 passing.
6. Ask "Draft a reply to Kate Morgan". The draft now says the fix is ready, because the run is in the graph.
7. Ask "why did we move to Stripe Billing?", "what breaks if billing-db goes down?", and "how is Kate Morgan connected to Priya Raman?".
8. Open the **Graph** tab and the Cypher console.

`scripts/e2e.mjs` drives the whole flow against a running server:

```bash
node scripts/e2e.mjs
```

### MCP

```bash
ZIV_USER=<your id> npm run mcp
```

Add it to any MCP client. For example, Claude Code: `claude mcp add zivbot -- npx tsx /path/to/zivbot/server/mcp.ts`. You get `triage`, `who_knows`, `blast_radius`, `decision_trace`, `connection_path`, `recall`, `run_cypher` and more, and each answer ends with the Cypher behind it.

### Desktop

`desktop/` is an Electron shell, so the dots really do run on their own computer. It:

- starts FalkorDB through Docker if needed
- runs the bundled server
- opens the app with a macOS inset title bar and a tray icon
- lets you pair your phone over the LAN

```bash
cd desktop && npm install && npm run bundle && npm start
```

### Android

`mobile/` is an Expo (SDK 52) app. <p><img src="docs/screenshots/android-pair.png" width="240"> <img src="docs/screenshots/android-chats.png" width="240"></p>

Pair it by scanning the QR code under *profile panel → Phone* on your computer. From then on your phone talks to the dots on your computer: the same graph, with native notifications and haptics. The coding agents and your data stay on your machine.

```bash
cd mobile && npm install && npx expo start --android
```

For an APK: `eas build -p android --profile preview`.

## Data used

The demo graph uses only **synthetic data** (the fictional Lumen Labs, under `server/seed/lumen.ts` and `demo/lumen-payments`) and **public data** (public GitHub repos, HN, RSS, Wikipedia), per hackathon rule 6. The key-based connectors are built for real use after the hackathon. Credentials are stored in `~/.zivbot/secrets.json` (mode 0600) and never in the graph.

## Project layout

```
server/            Hono API, agent, tools, fleet, memory, connectors, MCP server
  tools.ts         graph tools (all the Cypher above)
  agent.ts         dot turns: LLM tool loop / graph planner, dot↔dot messaging, onboarding
  fleet.ts         coding-agent subscriptions: detect, route (Cypher), run, record
  memory.ts        conversations, episodes, provenance
  analytics.ts     COLLABORATES + PageRank / label propagation / betweenness
  connectors/      demo workspace, public (no key), live (API key), MCP client
web/               React UI (GrokBot / ChatGPT-dots style)
desktop/           Electron app
mobile/            Expo Android/iOS app
demo/              lumen-payments: the synthetic repo the coding agents fix
```

## Built with AI assistance (rule 11)

ZivBot was built during the hackathon with **Claude Code** (Anthropic) as a coding assistant, plus a background sub-agent that wrote the API-key connector adapters. The logo, character art and hero image were generated with ChatGPT image generation and cut out locally (originals in `brand/`). The product direction, the graph model decisions, testing against real coding agents and the review are the team's. The coding-agent runner and quota detection are adapted from the author's own open-source project [Loom](https://github.com/nickthelegend/loom).

## License

MIT
