# 🧭 Routing Auditor

> A local Codex companion that proves whether a cheaper model or reasoning tier would have produced an equivalent result.

![Runtime](https://img.shields.io/badge/runtime-Bun%20%3E%3D%201.2-black)
![Language](https://img.shields.io/badge/language-TypeScript-3178c6)
![Protocol](https://img.shields.io/badge/protocol-ACP-555)
![Scope](https://img.shields.io/badge/scope-local%20first-0a7)

Routing Auditor watches the Codex prompts you already send, reruns them with a cheaper recommended route, and records whether that cheaper route actually held up.

This is a **preliminary evidence-gathering project**, not a finished routing product. Its job is to collect real data about your prompts, model choices, quality gaps, and cost tradeoffs so later routing decisions can be based on evidence instead of intuition.

It also deliberately consumes **more tokens than normal Codex usage**. Each audited prompt can trigger an assessment call, a cheaper verification rerun, and a judge call. Early on, the tool may cost more than it saves; that extra spend is the learning investment.

## 🎯 What It Is For

Routing Auditor answers the question that normally stays vague:

**Did this prompt really need `gpt-5.5 high`, or would `gpt-5.4-mini low` have been enough?**

Use it when you want evidence instead of routing guesses:

- Find prompts that could have used a cheaper model or reasoning tier.
- Measure whether cheaper reruns match the original output.
- Track audit cost, savings, ROI, and break-even.
- Build a local dataset of routing decisions over time.

## 🏁 Result

After it is running, you get:

- A queue of captured Codex prompts.
- Cheaper-route verification through ACP.
- Judge scores comparing original output vs cheaper output.
- Reports for losses, ROI, investment, and routing stats.
- A small task-completion notice when a verified cheaper route succeeded, including the verified model/tier.
- Local records under `~/.routing-auditor/`.

Everything stays on your machine. There is no telemetry.

Example stored payload, simplified from a completed `prompts.jsonl` record:

```json
{
  "prompt": "What is 2+2? Reply with just the number.",
  "codex_model": "gpt-5.5",
  "codex_tier": "high",
  "actual_execution": {
    "model": "gpt-5.5",
    "tier": "high",
    "output": "4",
    "input_tokens": 12,
    "output_tokens": 1,
    "estimated": false,
    "latency_ms": 1000,
    "captured": true
  },
  "assessment": {
    "model": "gpt-5.5",
    "tier": "high",
    "recommended_model": "gpt-5.4-mini",
    "recommended_tier": "low",
    "confidence": 100,
    "acceptable_models": [
      {
        "model": "gpt-5.4-mini",
        "tier": "low",
        "predicted_quality_score": 100
      }
    ]
  },
  "verification": {
    "model": "gpt-5.4-mini",
    "tier": "low",
    "output": "4",
    "status": "succeeded"
  },
  "judge": {
    "winner": "tie",
    "original_quality_score": 100,
    "cheaper_quality_score": 100,
    "quality_gap_score": 0
  },
  "costs": {
    "assessment_cost": 0.006055,
    "verification_cost": 0.000012,
    "judge_cost": 0.00192,
    "total_audit_cost": 0.007987,
    "actual_execution_cost": 0.00009,
    "predicted_execution_cost": 0.000012,
    "gross_savings": 0.000078,
    "net_savings": -0.007909
  },
  "verified": true,
  "verification_succeeded": true,
  "completion_notice_shown": false
}
```

## 🚀 Install

### ⚡ No-Clone Install

Run this from any directory:

```bash
bunx github:LivioGama/routing-auditor install
```

That command installs the package through Bun, creates or updates `~/.codex/hooks.json`, creates `~/.routing-auditor/`, and starts the daemon in the background automatically.

The installed hooks use the stable `bunx github:LivioGama/routing-auditor ...` command instead of a temporary clone path.

To reinstall cleanly, add `--force`. Forced install rewrites Routing Auditor's hook entries, refreshes config defaults, clears queued jobs, and restarts the daemon.

Use the same `bunx` form for reports:

```bash
bunx github:LivioGama/routing-auditor losses
bunx github:LivioGama/routing-auditor roi
bunx github:LivioGama/routing-auditor stats
```

To remove it later:

```bash
bunx github:LivioGama/routing-auditor uninstall
```

That removes Routing Auditor's Codex hooks and stops the background daemon. It keeps `~/.routing-auditor/` by default so you do not lose your records. Add `--remove-data` for a full cleanup.

To pause without uninstalling:

```bash
bunx github:LivioGama/routing-auditor disable
bunx github:LivioGama/routing-auditor enable
```

`disable` stops the daemon and leaves hooks installed, but the hooks ignore new prompts while paused. `enable` resumes capture and starts the daemon again.

### 📦 Clone Fallback

```bash
git clone https://github.com/LivioGama/routing-auditor routing-auditor
cd routing-auditor
bun install
bun link
routing-auditor install
```

`bun install` installs Zed's ACP adapter package, `@zed-industries/codex-acp`, which provides the `codex-acp` stdio server used for assessment, verification, and judging.

`routing-auditor install` creates or updates `~/.codex/hooks.json`, creates the local data files under `~/.routing-auditor/`, and starts the daemon in the background. Add `--no-daemon` if you only want to install hooks/config.

Use `routing-auditor install --force` when reinstalling. It clears the queue before the daemon resumes so stale jobs do not replay after the new install.

## 🛠 Usage

Run the Codex CLI normally after install. The daemon is started automatically.

When a Codex CLI prompt has been successfully verified by the daemon, Routing Auditor displays a completion notice through the Codex Stop hook:

> Routing Auditor: this task could have run with routing-auditor/fast-agent (verified model: gpt-5.4-mini low).

This notice is Codex CLI-only. Codex sessions driven through ACP do not trigger Codex Stop hooks, so Routing Auditor records and verifies hook-captured CLI prompts but does not try to inject completion notices into ACP-driven sessions.

```bash
routing-auditor losses
routing-auditor roi
routing-auditor stats
```

Core commands:

- `install`: install Codex hooks, create local data files, and start the daemon. Add `--force` to reinstall and clear queued jobs.
- `uninstall`: remove Routing Auditor hooks and stop the daemon. Add `--remove-data` to delete local records.
- `enable`, `disable`: resume or pause auditing without removing hooks or records.
- `daemon`: run the background worker. Add `--once` for one queued job.
- `losses`, `roi`, `investment`, `stats`: inspect payback and routing performance.
- `config`, `config --set key=value`: view or update settings.
- `report daily|weekly|monthly`: save report snapshots.
- `run "<prompt>"`: manually queue and process a prompt for smoke testing.

## ⚙️ Configuration

`~/.routing-auditor/config.json` is created during install.

Important settings and defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Whether hooks should capture new prompts for auditing. |
| `assessmentModel` | `gpt-5.5-high` | Model/tier used to predict which cheaper route should work. |
| `judgeModel` | `gpt-5.5-high` | Model/tier used to judge original output vs cheaper rerun output. |
| `verificationEnabled` | `true` | Whether to actually rerun the prompt with the cheaper recommendation. |
| `verificationThreshold` | `5` | Maximum allowed `quality_gap_score` for the cheaper route to count as successful. |
| `fastMode` | `true` | When true, uses faster execution with shorter timeouts (90s) and lower default tiers for assessment, verification, and judging. Useful for quick iteration during development. |
| `maxSuggestedModels` | `1` | Maximum number of acceptable cheaper routes stored from assessment. Routes are sorted cheapest first before capping. |
| `acpCommand` | `codex-acp` | ACP stdio server command. Fresh installs prefer the local Zed adapter binary when present. |
| `acpArgs` | `[]` | Extra arguments passed to the ACP server command. |
| `datasetValuePerRecord` | `0.05` | Assumed future value, in USD, of each verified routing record. |
| `projectionHorizonDays` | `30` | Horizon used for savings/payback projections. |
| `pollIntervalMs` | `2000` | Daemon polling interval when no job is ready. |
| `maxConcurrentJobs` | `1` | Reserved concurrency limit for worker processing. |

`acpCommand` defaults to `codex-acp`, the stdio ACP server command. Fresh installs prefer this project's local `node_modules/.bin/codex-acp` from `@zed-industries/codex-acp` when it exists. It should not point at the interactive `codex` CLI unless that command is explicitly wrapping an ACP server in your environment.

Pricing defaults are USD per 1,000,000 tokens and are meant as estimates. If you use Codex through a subscription instead of direct API billing, replace them with your own effective rates.

## 📌 Notes

- This is an exploratory data-collection tool. Treat its recommendations as evidence to inspect, not as an automatic production router.
- It spends extra tokens by design: assessment + verification + judging can cost more than the original prompt.
- Routing Auditor is designed as a personal/local tool, not a multi-worker production service.
- Token counts may be estimated when ACP does not return usage.
- Pricing defaults are useful estimates, not a guarantee of your actual bill.
- Prompt records stay in your local data directory.
