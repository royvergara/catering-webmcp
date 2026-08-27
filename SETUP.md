# Push this to GitHub, then let Vercel auto deploy

## 1. Create the repo (works from a phone)
github.com → New repository → name it `catering-webmcp` → **Public** → **do not** add a README,
.gitignore, or licence (this zip already has them) → Create.

Copy the repo URL, e.g. `https://github.com/<you>/catering-webmcp`.

## 2. Push it (needs a laptop, about 60 seconds)
Unzip this folder, then:

```bash
cd catering-webmcp
git init -b main
git add .
git commit -m "Catering WebMCP: reference vendor tools, planning engine, planner surface"
git remote add origin https://github.com/<you>/catering-webmcp.git
git push -u origin main
```

## 3. Tell me the repo URL
I'll link it to the existing Vercel project. After that every push deploys automatically and
partial deploys stop being able to wipe the tree.

## Checks before you push
```bash
npm test      # 26 tests, all passing
npm run dev   # http://localhost:8080
```

## What is in here
```
index.html          hub
plan.html           the planner, registers its own tools
vendor.html?v=slug  vendor page, registers 5 tools from data/vendors/<slug>.json
harness.html        fire every tool by hand, works without WebMCP
smoke.html          tool discovery check
shared/theme.js     design tokens (Tailwind config)
shared/ui.css       component layer: chit, row, tape, badge, field, btn, readout
shared/ui.js        header, nav, badges, formatters
shared/vendor-tools.js  the 5 tool definitions, pure
shared/plan.js      parse, compose basket, explain arithmetic, ownership table
engine/engine.js    4 checks: quantity, coverage, unclaimed, timing
engine/*.test.mjs   26 unit tests
data/vendors/*.json six reference vendors
```

## Two traps already hit, do not undo them
1. **Never use implicit id globals in a module.** `status`, `name`, and `length` are window
   built-ins; assigning to them throws in strict mode and kills the whole script silently.
   Always `document.getElementById`.
2. **A manual Vercel deploy replaces the entire file tree.** Deploying two files deletes
   everything else. Git deploys fix this.
