---
name: verify-relay-feed
description: Check that the Sovereign Relay Atlas feed only ever shows articles from the relays currently in the list, even when relay edits start new loads while old ones are in flight, and that same-slug articles from different authors both appear. Use when changing loadArticles, fetchEventsFromRelays, fetchEventsFromRelay, dedupeArticles, setLoading, or the relay add, edit and remove handlers in app.js.
---

# Verify the relay feed

**Properties.** `ShowsOnlyCurrentRelays`: when every load has finished, the page shows articles only from relays still in the list. `tests/feed-rules.spec.js` also checks that two authors' articles with the same `d` tag both appear.

**Harm if broken.** A reader removes a relay they distrust and still sees its articles, or loses an article that shares a slug with someone else's.

## Run

```sh
export TLA2TOOLS=/absolute/path/to/tla2tools.jar   # TLC 1.7.4 release
export JAVA=/path/to/java                          # Java 11 or later
bash scripts/verification/check-model.sh .claude/skills/verify-relay-feed/model/Feed.tla
bash scripts/verification/check-model.sh .claude/skills/verify-relay-feed/model/Feed.tla --mutant
npx playwright install chromium   # once per machine
npx playwright test tests/feed-rules.spec.js
```

The model must pass (8 distinct states). The `--mutant` run replays the code before commit d497fca and must report `ShowsOnlyCurrentRelays` violated: both loads start, the new one finishes, and the old one finishes last and renders the removed relay. The Playwright test replays that path with an 800 ms slow mock relay. Read every TLC result with the pstack `/statechart` skill.

## Coverage

Synced with the code at commit `d497fca`. Move this forward only after you confirm that the model still describes the code at the new commit.

| Model step | Code (`app.js`) |
| --- | --- |
| `Start` | `loadArticles` takes `generation = ++loadGeneration`; called on load, refresh, relay submit and remove |
| `Finish` | after `fetchEventsFromRelays` for articles and profiles; renders only if `isCurrent()` |

## Not covered

Event signatures (relays are trusted to return real events), relay timeouts beyond their effect on timing, and the article reader.
