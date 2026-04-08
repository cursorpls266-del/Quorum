<p align="center">
  <h1 align="center">Quorum</h1>
  <p align="center"><strong>Your server's rules, written by your community.</strong></p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/gitagent-spec%20v0.1.0-blue" alt="gitagent spec">
  <img src="https://img.shields.io/badge/runtime-gitclaw-orange" alt="gitclaw powered">
  <img src="https://img.shields.io/badge/model-groq%20llama--3.3--70b-green" alt="groq model">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="node version">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license">
  <img src="https://img.shields.io/github/actions/workflow/status/Hari19hk/Quorum/validate.yml?label=agent%20validation" alt="CI">
</p>

---

## What is Quorum?

Quorum is a Discord moderation agent where no single person writes the rules.

The entire rulebook is a [`RULES.md`](RULES.md) file in a public GitHub repository. Community members propose changes via Pull Request. The community votes in Discord. If the vote passes, the PR merges, and the agent's behavior changes instantly — tied to a git commit hash that anyone can verify.

Every moderation action Quorum takes is cryptographically traceable to the exact version of the rules that justified it. Every user who gets moderated receives a DM with the rule they violated, the commit hash, and a direct link to open a PR if they think the rule is wrong.

This is not a bot with a config panel. It is a governance system built on git.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        GITHUB REPOSITORY                         │
│                                                                  │
│  SOUL.md ─── Agent identity and values                           │
│  DUTIES.md ── Segregation of duties policy                       │
│  RULES.md ─── Community-governed constitution                    │
│  skills/ ──── Deterministic evaluation workflows                 │
│  agent.yaml ─ GitAgent spec configuration                        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐        │
│  │ .github/workflows/validate.yml                       │        │
│  │ Runs `gitagent validate` on every PR to RULES.md     │        │
│  │ Malformed rules cannot be merged.                    │        │
│  └──────────────────────────────────────────────────────┘        │
└──────────────────┬───────────────────────────┬───────────────────┘
                   │                           │
        git pull on merge              PR opened webhook
                   │                           │
                   ▼                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     BRIDGE (Node.js)                             │
│                                                                  │
│  index.js ────── Discord listener + GitClaw orchestrator         │
│  webhook.js ──── GitHub webhook receiver + voting engine         │
│  logger.js ───── Atomic append-only audit writer                 │
│  ruleValidator.js ── Rule ID validation + cooldown enforcement   │
│                                                                  │
│  ┌────────────┐    ┌────────────┐    ┌─────────────────┐        │
│  │  EVALUATOR  │───▶│  EXECUTOR  │───▶│     AUDITOR     │        │
│  │  (GitClaw)  │    │  (Bridge)  │    │ (moderation-log)│        │
│  │             │    │            │    │                  │        │
│  │ Reads rules │    │ Deletes msg│    │ Logs action with │        │
│  │ Returns JSON│    │ Sends DM   │    │ commit hash      │        │
│  └────────────┘    └────────────┘    └─────────────────┘        │
└──────────────────────────────────────────────────────────────────┘
                   │                           │
                   ▼                           ▼
┌─────────────────────────┐  ┌─────────────────────────────────────┐
│      DISCORD SERVER      │  │         LOCAL MEMORY                │
│                          │  │                                     │
│  #general ── monitored   │  │  memory/runtime/moderation-log.md   │
│  #governance ── votes    │  │  memory/runtime/rule-changelog.md   │
│  #mod-channel ── escals  │  │                                     │
│  DMs ── appeal notices   │  │  Append-only. Never pushed.         │
└─────────────────────────┘  │  Private court records.              │
                              └─────────────────────────────────────┘
```

---

## The Democratic Loop

```
  Community member              GitHub                   Discord
  disagrees with a rule
        │
        ├── Forks repo
        ├── Edits RULES.md
        └── Opens Pull Request ──────▶ PR #7 created
                                            │
                                            │ webhook
                                            ▼
                                      ┌───────────────┐
                                      │  #governance   │
                                      │                │
                                      │  📜 PR #7      │
                                      │  ✅ 4  ❌ 1    │
                                      │                │
                                      │  Vote closes   │
                                      │  in 60 seconds │
                                      └───────┬───────┘
                                              │
                                    ┌─────────┴─────────┐
                                    │                   │
                              ✅ wins              ❌ wins
                                    │                   │
                            Auto-merge PR        Auto-close PR
                                    │                   │
                              git pull             "REJECTED"
                                    │              posted to
                            New rules loaded       #governance
                                    │
                            Agent behavior
                            changes instantly
```

---

## GitAgent Patterns Used

| Pattern | Implementation |
|---|---|
| **Agent Diff & Audit Trail** | Every moderation action logged with the git commit hash of the rules version that justified it |
| **Segregation of Duties** | Full [`DUTIES.md`](DUTIES.md) with five roles: evaluator, executor, auditor, governor, supervisor — with explicit conflict matrix |
| **Live Agent Memory** | `memory/runtime/moderation-log.md` — append-only structured audit log |
| **Branch-based Deployment** | Rule changes deployed exclusively via PR merge to `main` |
| **CI/CD for Agents** | GitHub Actions runs `gitagent validate` on every PR touching agent files |
| **Agent Versioning** | Every rule change is a git commit; every ruling references its commit |
| **Human-in-the-Loop** | Confidence < 0.75 triggers automatic escalation to human moderators |
| **Agent Lifecycle Hooks** | `hooks/` directory with validation and escalation scripts |
| **SkillsFlow** | Three deterministic skills with strict input/output contracts |

---

## Skills

Quorum uses three focused skills, each with a single responsibility:

### `evaluate-message`
The core judgment skill. Reads the incoming message, cross-references it against every rule in `RULES.md`, and returns a strict JSON verdict: `APPROVE`, `DELETE`, or `ESCALATE`. No commentary. No explanation outside the JSON. The agent is a judge, not a conversationalist.

### `explain-ruling`
Activated when a moderated user asks why. Reads the audit log, finds their specific ruling, retrieves the rule text and its PR history, and composes a plain English explanation ending with appeal instructions.

### `suggest-appeal`
Guides a community member through opening a GitHub PR to challenge a rule. Provides the exact fork-edit-PR workflow and a ready-to-use PR template. Encouraging but honest — the community decides, not the bot.

---

## What Makes This Different

Every other moderation bot is a black box. An admin configures hidden prompts. The community has no visibility into why decisions are made. There is no mechanism to challenge the rules themselves.

Quorum inverts this entirely:

- **Rules are public.** `RULES.md` is readable by anyone.
- **Rules are amendable.** Open a PR. The community votes. If it passes, the rule changes.
- **Rulings are traceable.** Every deletion includes the git commit hash. Run `git show <hash>:RULES.md` to see exactly what rules existed at the moment of enforcement.
- **The bot can be put on trial.** If the community decides a rule is wrong, they change it — and the bot obeys.
- **Git diff is democratic infrastructure.** The `#governance` channel receives the raw diff of every rule change. Democracy made visible.

---

## Quick Start

### Prerequisites

- Node.js 18+
- A Discord bot with `Manage Messages`, `Send Messages`, and `Message Content` intents
- [Groq API key](https://console.groq.com) (free tier works)
- [GitHub Personal Access Token](https://github.com/settings/tokens) with `repo` scope
- [ngrok](https://ngrok.com) for webhook tunneling (development)

### 1. Clone and install

```bash
git clone https://github.com/Hari19hk/Quorum.git
cd Quorum/bridge
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `bridge/.env`:

```env
# Discord
DISCORD_TOKEN=your_discord_bot_token
MOD_ROLE_ID=your_moderator_role_id
MOD_CHANNEL_ID=your_mod_channel_id
GOVERNANCE_CHANNEL_ID=your_governance_channel_id

# GitHub
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GITHUB_PAT=your_github_pat
VOTING_PERIOD_MS=60000

# Model
GROQ_API_KEY=your_groq_api_key

# Agent
AGENT_DIR=..
SHADOW_MODE=false
RULE_COOLDOWN_HOURS=24
```

### 3. Start the bot

```bash
cd bridge
node index.js
```

### 4. Expose webhook (development)

```bash
ngrok http 3000
```

Add the ngrok URL + `/webhook` to your GitHub repository's webhook settings.

### 5. Configure GitHub Webhook

1. Go to your repo → **Settings** → **Webhooks** → **Add webhook**
2. **Payload URL:** `https://your-ngrok-url.ngrok-free.app/webhook`
3. **Content type:** `application/json`
4. **Secret:** Same as `GITHUB_WEBHOOK_SECRET` in `.env`
5. **Events:** Select `Pull requests`

---

## How to Propose a Rule Amendment

1. Fork [this repository](https://github.com/Hari19hk/Quorum)
2. Edit `RULES.md` — add, modify, or remove a rule in the **Community Rules** section
3. Open a Pull Request with the title: `Amend RULE-XXX: [your proposed change]`
4. The bot posts the diff to `#governance` with ✅ and ❌ reactions
5. The community votes within the voting period
6. If ✅ wins — the PR is automatically merged and the bot updates instantly
7. If ❌ wins — the PR is automatically closed
8. If tied — the PR stays open for moderator review

> **Note:** The Operational Rules section at the top of `RULES.md` cannot be amended via community PR. These are constitutional constraints that protect the integrity of the system itself.

---

## Project Structure

```
Quorum/
│
├── agent.yaml                  # GitAgent spec — model, skills, compliance config
├── SOUL.md                     # Agent identity — who Quorum is and what it values
├── DUTIES.md                   # Segregation of duties — five roles, conflict matrix
├── RULES.md                    # The constitution — community-governed, PR-amendable
│
├── skills/
│   ├── evaluate-message/       # Core judgment — message → JSON verdict
│   ├── explain-ruling/         # Post-moderation explanation for affected users
│   └── suggest-appeal/         # PR template and instructions for rule challenges
│
├── bridge/
│   ├── index.js                # Discord listener + GitClaw orchestrator
│   ├── webhook.js              # GitHub webhook receiver + democratic voting engine
│   ├── logger.js               # Atomic append-only audit trail writer
│   ├── ruleValidator.js        # Rule ID validation + cooldown enforcement
│   ├── package.json            # Dependencies
│   └── .env                    # Secrets (gitignored)
│
├── memory/
│   ├── memory.yaml             # Memory configuration
│   └── runtime/                # Live agent memory (gitignored — private)
│       ├── moderation-log.md   # Every action: user, rule, verdict, commit hash
│       └── rule-changelog.md   # Every PR merge: date, author, diff summary
│
├── hooks/
│   ├── hooks.yaml              # Lifecycle hook definitions
│   └── scripts/
│       ├── validate-rules.sh   # Pre-action validation
│       ├── audit-tool-call.sh  # Tool call auditing
│       └── escalate-error.sh   # Error escalation handler
│
├── workflows/
│   └── moderate-message.yaml   # Deterministic moderation workflow
│
├── config/
│   └── default.yaml            # Default configuration
│
├── examples/
│   ├── bad-example.md          # Example of a violating message
│   └── good-output.md          # Example of correct agent output
│
└── .github/
    └── workflows/
        └── validate.yml        # CI — runs gitagent validate on every PR
```

---

## Safety Features

| Feature | Description |
|---|---|
| **Confidence escalation** | Verdicts below 0.75 confidence are routed to human moderators |
| **Rule cooldown** | Newly merged rules are inactive for 24 hours — prevents malicious instant enforcement |
| **Rule ID validation** | If the LLM hallucinates a nonexistent rule, the action is escalated instead of executed |
| **Shadow mode** | Run the full pipeline without taking any Discord actions — safe for testing |
| **Atomic logging** | Audit log is written *before* any Discord action — no silent deletions |
| **Moderator exemption** | Messages from users with the moderator role are never evaluated |
| **Rate limiting** | Per-user rate limiting prevents abuse of the evaluation pipeline |
| **CI validation** | `gitagent validate` runs on every PR — malformed rules cannot be merged |

---

## Tech Stack

| Component | Technology |
|---|---|
| Agent Standard | [gitagent](https://github.com/AugmentoLabs/gitagent) spec v0.1.0 |
| Runtime | [gitclaw](https://www.npmjs.com/package/gitclaw) SDK |
| Model | Groq `llama-3.3-70b-versatile` |
| Discord | discord.js v14 |
| Webhook Server | Express.js |
| CI/CD | GitHub Actions |
| Language | Node.js 18+ (ES Modules) |

---

## License

MIT — see [LICENSE](LICENSE) for details.
