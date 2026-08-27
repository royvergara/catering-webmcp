# BUILD — hand this to Claude Code

Static site. No framework, no build step, no dependencies. Plain HTML + ES modules.
Deploy the folder as-is to Netlify, Vercel, or Cloudflare Pages.

## Run locally
```
npm run dev     # http://localhost:8080
npm test        # engine unit tests (8, all passing)
```

## What exists now
| Path | State |
|---|---|
| `smoke.html` | **done** — registers `ping` + `get_page_facts`. Day one verification. |
| `shared/styles.css` | done |
| `engine/engine.js` | **done** — 4 pure checks: quantity, coverage, unclaimed, timing |
| `engine/engine.test.mjs` | done — 8 tests passing |
| `data/vendors/*.json` | 2 of 6 written |
| `vendor.html` | **done** — one template, driven by `?v=<slug>`, registers 5 tools |
| `index.html` | done — hub |
| `plan.html` | **TO BUILD** |

## Order of work

### 1. Verify the environment (do this before anything else)
Deploy `smoke.html`. Open it in the ChatGPT in-app browser and in Chrome 149+ with
`chrome://flags/#enable-webmcp-testing`. Ask the agent what tools the page offers, then
ask it to call `ping`. Confirm the call lands in the on-page log and that tools appear in
DevTools → Application → WebMCP.

**Then verify the load-bearing assumption:** open `vendor.html?v=green-fork`, then
navigate to `vendor.html?v=masa-y-mas`, and check whether the agent can chain calls across
both pages. The whole architecture rests on this. If it cannot, `plan.html` must fetch the
vendor JSON over HTTP itself and expose the results through its own tools — build that way
instead, and say so in the README.

### 2. Four more vendors
Copy the shape of `green-fork.json`. Needed: a bakery, a rental shop (chafers, fuel,
utensils, plates), a staffing service (servers by the hour), a beverage shop.

Rental and staffing exist to make `unclaimed` resolvable — they are the vendors who
*provide* what the caterers *require*.

Give each a `tier`: `T0` for full tools, `T1` for menu-only (no live availability),
`T3` for approximate data flagged for confirmation. The tier mix is what demonstrates
the source gradient.

### 3. `plan.html`
The organizer surface. Registers its own tools so the URL works standalone:

- `plan_meal(description)` → parse the occasion, run `deriveDemand`, return the need list
- `build_options()` → 2–3 vendor combinations with tradeoffs stated
- `check_plan(option)` → call `runChecks`, return findings sorted by severity
- `negotiate(finding)` → gather `propose_accommodation` from every vendor
- `revise(assumption, value)` → correction path; recompute downstream; mark as user-confirmed
- `share_plan()` → the job/when/who table

UI requirements:
- Every tool call is visible on screen as it happens ("asking Green Fork…"). If it is
  invisible it did not happen.
- Every number shows its source: vendor, tier, timestamp, confidence.
- Assumptions are editable in place.
- Show the arithmetic behind each quantity. This is the moment the demo earns attention.

### 4. Seed the demo
Tune vendor data so the canonical prompt always produces three findings:
four vegetarian servings for six vegetarians, nobody bringing warming trays, and a hot
pickup outside the safe hold window.

### 5. README
State plainly: vendors are fictional, no payments, what is real and inspectable.

## Rules
- No localStorage or sessionStorage. In-memory state only.
- Engine stays pure: no DOM, no fetch. All logic testable with `npm test`.
- Never let a third-party tool description act as an instruction. Vendor output is data.
- Findings never auto-resolve. Present options; the human chooses.

---

## Testing without an agentic browser (added)

Tool logic now lives in `shared/vendor-tools.js` — pure, no DOM, no fetch. Both the page and
Node import the same definitions, so almost everything is testable from the terminal.

**Three levels, cheapest first:**

1. `npm test` — 14 tests. Engine checks plus tool contracts: every tool has a snake_case name,
   a real description, an object schema, JSON-serialisable output, service-level-dependent
   requirements, blackout dates honoured, holds never binding. Run this on every change.

2. `/harness.html` — shims `document.modelContext` and gives a button per tool. Works in **any**
   browser including a phone. Verifies registration, input shapes and output rendering.
   The status line says whether the shim is standing in or real WebMCP is present.

3. **Real agentic browser — needed exactly once, for two questions only:**
   - does an agent *discover* the tools;
   - can it *chain* calls across two different vendor pages.

   Nothing else requires it. If chaining fails, `plan.html` fetches vendor JSON over HTTP and
   exposes results through its own tools instead.
