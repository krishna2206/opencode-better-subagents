# opencode-better-subagents

OpenCode plugin providing configurable fallback chains for subagents, in-memory
circuit breaking on model failures (429, quota limits, provider errors), and
automatic cleanup of failed child sessions.

## Features

- **Model Fallback Chains**: Specify an ordered list of candidate models per subagent (e.g. `explore`).
- **Circuit Breaker**: When a model fails, it enters a configurable cooldown (default: 5 minutes). Subsequent subagent runs (including background runs) skip cooled-down models immediately.
- **Catalog Filtering**: Candidates missing from OpenCode's chat model catalog (disabled provider, unknown variant) are skipped before any call. If none is available, the call fails fast.
- **Background Runs**: A `background: true` launch never clears a cooldown on its own. The plugin watches the child session and updates the cooldown when the run actually succeeds or fails. A background run cannot be retried on another model after it has started.
- **Caller Errors Pass Through**: Permission denials, the depth limit, unknown agents and missing sessions are re-thrown as-is, without trying other models or putting them in cooldown.
- **Session Cleanup**: If a subagent run crashes and leaves behind an empty child session, the plugin cleans it up before moving to the next candidate.
- **Pass-through**: Explicit `model` overrides or existing `sessionID` continuations are passed through untouched.
- **No masking of user aborts**: User cancellations and aborts stop immediately without falling back.

## Configuration

In `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "file:///path/to/opencode-better-subagents/dist",
      "options": {
        "cooldownSeconds": 300,
        "agents": {
          "explore": [
            "claude-code-proxy/claude-sonnet-5-5#high",
            "commandcode-proxy/commandcode-deepseek-v4.1-flash#max",
            "antigravity-proxy/antigravity-gemini-3.8-flash#high"
          ]
        }
      }
    }
  ]
}
```

## Development

```sh
bun test
bun run build
```
