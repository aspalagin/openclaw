# Live proof for openclaw/openclaw#179902

Retained Telegram progress card after `sessions_yield`: the resumed requester's `progress_card` update must advance the same card's checklist.

## Setup

- Gateway: isolated source Gateway (`node --import ./scripts/tsx.mjs src/entry.ts gateway`) from the PR worktree, fresh state per run, loopback only.
- Telegram: production Telegram with a dedicated test bot created for this proof. The user side is a real Telegram account; its client produced the screenshots, and a user-session recorder polled the bot chat every 2 s for new messages, edits and deletions.
- Channel config: `streaming: { mode: "progress", block: { enabled: false }, progress: { commentary: true } }`, `tools: { profile: "full", codeMode: false, toolSearch: false }`, `messages.visibleReplies: "automatic"`.
- Model: deterministic OpenAI Responses mock (`mock-provider.mjs`, adapted from `.agents/skills/telegram-e2e-userbot/scripts/reply-policy-mock.mjs`). Only model decisions are synthetic. `progress_card`, `sessions_spawn` (`completionTarget: "parent"`), `sessions_yield` (with an acknowledgment), the child run, the requester settle wake, card adoption and Telegram delivery are real.
- Scenario: parent `progress_card` (0/3) → `sessions_spawn` → `sessions_yield` → child (held) → settle wake `progress_card` (1/3) → held final → final text.

## Results

| Run | Code | Retained card after the settle wake's `progress_card` (1/3) |
| --- | --- | --- |
| `head-e0cace0-screenshots-run` | PR head `e0cace07c84` | Same message edited to `1/3 complete`, `[x] Fetch the recording`, `Transcribe it (in progress)` |
| `head-e0cace0-short-run` | PR head `e0cace07c84` | Same |
| `base-upstream-main-run` | `upstream/main` `08d77cab437` (the 4 changed production files reverted) | Stays `0/3 complete` until the card is retired with the final |

Screenshots (head, same message `02:08`, phone status bar cropped):

- `retained-card-0of3.jpg`: after adoption, child running.
- `retained-card-1of3.jpg`: after the settle wake's `progress_card`; the checklist advanced on the retained card.

Key timeline, head screenshots run (UTC):

- 23:06:40 user request sent
- 23:08:19 card created `0/3 complete`; 23:08:20 `sessions_yield`; 23:08:23 `transcribe: running` on the same card (adopted)
- 23:12:24 child completed; 23:12:36 settle wake `progress_card` (rev 2, 1/3)
- 23:12:38 same card edited to `1/3 complete`
- 23:16:38 final message; card deleted

Base run (UTC): settle wake `progress_card` (1/3) at 22:55:34; the card never left `0/3 complete` before the final at 22:55:56.
