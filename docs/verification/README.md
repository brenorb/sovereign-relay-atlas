# Relay feed verification

| Skill | What it checks | Tool |
| --- | --- | --- |
| [verify-relay-feed](../../.claude/skills/verify-relay-feed/SKILL.md) | The feed shows only current relays' articles; same-slug articles from different authors both appear | TLA+ / TLC, 8 states, plus `tests/feed-rules.spec.js` |

Fixed along the way:

1. A load started before a relay was removed could finish last and bring the removed relay's articles back.
2. Articles were deduplicated by `d` tag alone, hiding one of two authors' same-slug articles.
3. The Playwright web server served a hard-coded directory from another machine.

## Browse long-form articles

Generated with pstack `/statechart` from [Browse.tla](flows/browse-articles/Browse.tla) ([TLC report](flows/browse-articles/report.md)).

```mermaid
---
title: "Browse long-form articles"
---
stateDiagram-v2
  s0: Querying the relays
  s1: No articles found
  s2: Article cards
  s3: Asked to add a relay
  s4: Reading an article
  [*] --> s0
  s0 --> s1: relays return nothing
  s0 --> s2: relays return articles
  s0 --> s3: you remove the last relay
  s1 --> s0: you add, edit or remove a relay or you press refresh
  s1 --> s3: you remove the last relay
  s2 --> s0: you add, edit or remove a relay or you press refresh
  s2 --> s3: you remove the last relay
  s2 --> s4: you open a card
  s3 --> s0: you add, edit or remove a relay
  s4 --> s0: you add, edit or remove a relay
  s4 --> s2: you close the reader
  s4 --> s3: you remove the last relay
```
