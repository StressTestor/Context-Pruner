# context-pruner

your context window is not infinite. this plugin makes sure you're not wasting it on "ok sounds good" messages.

## the problem

long conversations eat context. most of that context is greetings, acknowledgments, and repetitive tool output that adds zero value to the agent's next response. you're paying for tokens that say "got it" and "thanks".

context-pruner scores every message by importance and automatically drops the low-value ones when your conversation gets too long. decisions, code blocks, error traces, and user preferences stay. "ok cool" gets cut.

## how it works

every message gets a 0-1 importance score based on what's in it:

| content | score |
|---|---|
| code blocks | 0.8+ |
| decisions ("always use X", "never do Y") | 0.75+ |
| errors / stack traces | 0.65+ |
| urls, file paths | 0.55+ |
| normal conversation | 0.4 |
| short acks ("ok", "thanks", "got it") | 0.1 |
| repetitive tool outputs | 0.2 |

when the conversation exceeds `maxMessages` (default 100), the plugin auto-prunes down to `targetMessages` (default 60) by removing the lowest-scored messages first.

## constraints

- first N messages are always kept (system prompt context)
- last N messages are always kept (recent context)
- tool call/result pairs are never orphaned — they get removed together or not at all
- the current user message is never pruned
- all scoring is local regex/heuristics. no API calls, no data leaves your machine.

## install

add to your `openclaw.json`:

```json
{
  "plugins": {
    "context-pruner": {
      "path": "/path/to/context-pruner"
    }
  }
}
```

## config

all optional. sane defaults.

```json
{
  "plugins": {
    "context-pruner": {
      "path": "/path/to/context-pruner",
      "maxMessages": 100,
      "targetMessages": 60,
      "minImportance": 0.3,
      "preserveRecent": 10,
      "preserveFirst": 3,
      "autoPrune": true
    }
  }
}
```

| key | default | what it does |
|---|---|---|
| `maxMessages` | 100 | auto-prune triggers above this |
| `targetMessages` | 60 | prune down to this count |
| `minImportance` | 0.3 | messages below this always get pruned first |
| `preserveRecent` | 10 | always keep last N messages |
| `preserveFirst` | 3 | always keep first N messages |
| `autoPrune` | true | auto-prune before each agent turn |

## usage

### slash command

```
/prune          # prune with default aggressiveness
/prune 2.0      # aggressive prune
/prune 0.5      # gentle prune
```

### tools

the agent can call these directly:

- `context_stats` — message count, token estimate, importance distribution
- `context_prune` — manual prune with optional aggressiveness param

### cli

```bash
openclaw context stats     # show context stats
openclaw context prune     # manual prune
openclaw context prune --dry-run    # see what would be removed
openclaw context prune --aggressive 2.0
openclaw context score 42  # score a specific message
```

## day 3 of 20 days of claw

part of the [20 days of claw](https://github.com/StressTestor) series — 20 plugins for the openclaw ecosystem.
