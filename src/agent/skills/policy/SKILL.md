---
name: policy
description: The full policy rule format for policy_update, including history conditions, rate limits, and approval options. Read it before writing a rule that counts earlier calls, caps how often a tool runs, or sets an approval timeout or message.
---

# Policy rules

The kernel checks each tool call against the policy before it runs. The
bundle is a model-call rule (`allow-llm`), a rule that always asks before a
browser handoff (`handoff`), then the user's rules in order, then a rule that
asks for approval on every other tool call (`ask`). The first rule
whose `when` block matches decides. Read the user's rules with `policy_read`
and change them with `policy_update`.

A rule has an `id` (unique, and not `allow-llm`, `handoff`, or `ask`), a `when` block,
and a `then` block. Unknown keys make the bundle fail to load.

```yaml
id: message-user
when:
  target: message_send
  arguments:
    to:
      equals: user
then:
  decision: allow
```

## when

Every field present must match. Omitted fields are not checked.

| Field | Matches |
|-------|---------|
| `target` | The tool name, or a glob in Go's `path.Match` syntax (`mcp__linear__*`). |
| `targets` | A list of tool names or globs; matches if any matches. |
| `arguments` | Predicates on the call's JSON arguments, keyed by argument name. |
| `history` | Clauses about calls policy allowed earlier. |

### Argument predicates

Each key must be present in the call's arguments and every constraint under it
must pass. Values compare as strings; a value that is not a string compares as
compact JSON, so `false` compares as `false` and `{"a": 1}` as `{"a":1}`. A
predicate needs at least one constraint, and an empty `equals` is rejected.

| Constraint | Passes when the value |
|------------|-----------------------|
| `equals` | equals the string exactly |
| `contains` | contains the substring |
| `one_of` | is one of the listed strings |
| `regex` | matches the RE2 regular expression |
| `equals_arg` | equals this argument of the call being decided (history clauses only) |

A key with dots is a path into nested objects: `config.environment` reads
`environment` inside `config`. Arrays are not traversed.

```yaml
when:
  target: shell
  arguments:
    command:
      regex: '^\s*(ls|cat|pwd|date|git status)(\s+[^;&|<>$`()\\]*)?\s*$'
```

### History

`history` is a list of clauses about earlier calls that policy allowed:
started, succeeded, failed, or still running. Every clause must hold. The call
being decided counts toward a clause it matches unless the clause has `result`;
denied calls and calls waiting for approval do not count.

| Field | Meaning |
|-------|---------|
| `target`, `targets`, `arguments` | Select earlier calls, as in `when`. |
| `result` | Predicates on fields of the call's JSON result. Only succeeded calls match. |
| `scope` | `execution` (default), the current turn, or `session`, every turn in the conversation. |
| `within` | A Go duration (`10m`, `24h`). Only calls started that recently count. |
| `sum` | A numeric argument added up across the selected calls. |
| `distinct` | An argument whose distinct values are counted. |
| `at_least`, `at_most` | Bounds on the count, or on the `sum` or `distinct` total. Without either, `at_least: 1`. |

`at_most: 0` requires that something did not happen:

```yaml
id: no-send-after-browse
when:
  target: message_send
  history:
    - target: browser_observe
      scope: session
then:
  decision: require_approval
  reason: the conversation has read web content
```

A cap is an allow rule above a stricter one, so calls past the cap fall through:

```yaml
id: few-note-searches
when:
  target: notes__search
  arguments:
    query:
      regex: '.+'
  history:
    - target: notes__search
      within: 1h
      at_most: 20
then:
  decision: allow
```

## then

| Field | Meaning |
|-------|---------|
| `decision` | `allow`, `deny`, or `require_approval`. Required. |
| `reason` | Shown when the rule decides; returned on deny. |
| `approval_config` | With `require_approval`: `timeout` (a Go duration after which the approval expires) and `message` (shown to the user with the request). |
| `rate_limit` | Caps how often the rule fires. |

```yaml
then:
  decision: allow
  rate_limit:
    max_calls: 5
    window: 1m
    per_what: session        # execution (default) | session | agent | global
    max_wait: 5m             # wait for the bucket to refill; unset refuses
```

A call over a rate limit is refused as `rate_limited`. For a hard limit, use a
`deny` or `require_approval` rule.

## Required on allow rules

`policy_update` rejects allow rules that break these, and the user approves
every change after a readback:

- An allow rule names its targets.
- An allow on `package_write` needs `extensions: {equals: false}`.

Put specific rules above broad ones: a broad rule higher up shadows the rules
below it.
