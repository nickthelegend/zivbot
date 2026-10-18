# I gave my AI subscriptions a shared brain: building ZivBot on FalkorDB

*Draft for the Graph Hacks blog prize.*

I pay for Codex. I pay for Claude. I have OpenCode, Grok and Antigravity installed. And none of them knows that Kate at Brightwave has emailed three times about the same invoice bug, or that Priya already diagnosed it in Slack, or that the bug lives in the one repo nobody but Priya has touched.

The context is spread across a dozen apps, and the agents are spread across a dozen subscriptions. ZivBot is my attempt to connect the two with a graph.

## The idea: Zivs that act on connected data

ZivBot borrows the look of GrokBot and ChatGPT's "Zivs": friendly little agents you chat with, which keep working while you're away. Under the hood, every Ziv reads and writes **one FalkorDB graph per user**:

- **Connected data.** People, teams, customers, systems, repos, files, commits, tickets, email threads, meetings, Slack messages, Notion docs and decisions, all linked.
- **The agent fleet.** Each installed coding-agent subscription is an `:Agent` node. Every job it runs becomes a `:Run` that `WORKED_ON` systems and `RESOLVES` tickets.
- **Memory.** Every chat message is an `:Episode` that `MENTIONS` the entities it talks about. "Remember that I prefer Codex for backend fixes" becomes a `:Procedure` that `PREFERS` the Codex node.

## Three queries that made it click

**What should I handle first?** Ranking by "urgent" labels is useless. ZivBot follows tickets to the systems they affect, then up `DEPENDS_ON*1..3` to everything leaning on them, then out to the customers who `USE` any of those systems, and sums their ARR. The invoice-latency P1 jumps to the top because $246k of customers sit on its blast radius.

**Who should fix it?** Not "who", but which of my subscriptions. A single Cypher query scores each `:Agent` on:

- its wins and losses on the affected systems
- its wins on neighbouring systems one `DEPENDS_ON` hop away
- its quota state
- my stated preferences

Codex wins, and the card tells me why.

**Why did we decide that?** `(:Decision)-[:SOURCE]->(message or doc)`, plus `DECIDED_BY` and `APPROVED_BY`, means every "why" comes back with its source attached.

## Show the path

The feature I'm proudest of is the least flashy. Every Cypher statement goes through one function. While a Ziv is answering, an `AsyncLocalStorage` trace records the query, its timing, its row count, and every node uid the results touched. The reply is stored with an `(:Answer)-[:USED]->(node)` subgraph. Click **Show path** under any answer and you see the exact queries and the subgraph, including the work a *different* Ziv did when it was delegated to.

## Zivs talking to Zivs

Ask Ziv to fix a ticket and it messages Forge, the engineering Ziv. The exchange is just another conversation in the graph, so both Zivs remember it, and you get a little "Messaged Forge" chip you can open. Shared memory turns out to be the easy part of multi-agent coordination when the memory is a graph.

## What I'd do next

- Real OAuth for Google, Slack and Notion. The connectors exist, but for the hackathon everything you see is synthetic or public data.
- Vector search over `:Episode` and `:Doc` using FalkorDB's vector index.
- Letting Zivs open real pull requests through the GitHub connector once a run goes green.

Code: _repo link_ · Video: _link_
