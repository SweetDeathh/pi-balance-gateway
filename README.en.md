# pi-balance-gateway

[简体中文](README.md) | **English**

Show API relay wallet balances in the pi footer, for **several accounts at once**.

Works with any relay that exposes `GET {base}/v1/usage` and returns a `balance`
field. Relays that do not serve that endpoint simply fail the probe and are
skipped, without affecting the others.

---

## What it looks like

**One account:**

```
余额 $47.35
```

**Several accounts**, side by side on one line:

```
main $47.35 · backup $0.09 · alt $24.25
```

A failing account only affects itself:

```
main $47.35 · backup ?
```

---

## Install

```bash
pi install npm:pi-balance-gateway
```

Try it once without writing to settings:

```bash
pi -e npm:pi-balance-gateway
```

Or install from git (easier to read the source first):

```bash
pi install git:github.com/SweetDeathh/pi-balance-gateway
```

---

## Works out of the box — no configuration

The extension reads the `baseUrl` and `apiKey` you already configured in
`~/.pi/agent/models.json`.

**If pi can talk to a provider, that provider is already here — you never retype a key.**

On first start it automatically:

1. scans every provider that has a `baseUrl` + `apiKey`
2. probes `GET {base}/v1/usage` for each, in parallel
3. keeps only the ones that answer, collapsing providers that share a host
   (`example.com` and `www.example.com` count as the same wallet)
4. caches the result to `~/.pi/agent/balance.json`

No prompts, no files to edit.

---

## Choose which accounts to show

```
/balance setup
```

It probes first, then shows a tick-list. Press enter to toggle, pick
"save and close" when done:

```
Pick the accounts to show (toggle repeatedly; unusable ones show ?)
> [x] main        $47.35
  [x] backup      $0.09
  [x] alt         $24.25
  [ ] some-site   ✗ not JSON (404)
  ── save and close ──
```

The footer refreshes with your new selection immediately.

---

## Commands

| Command | Purpose |
|---|---|
| `/balance` | Report every account (recent usage, model top 3) |
| `/balance setup` | Interactive tick-list of accounts to show |
| `/balance probe` | Re-probe and keep every responsive account |
| `/balance list` | Show the current selection |
| `/balance add [name]` | Add one; shows a picker when no name is given |
| `/balance remove <name>` | Remove one |

---

## Tool for the model

Registers `check_balance`, so the model can answer "how much balance is left"
on its own.

It returns a structured `details.accounts[]` and trims `daily_usage` /
`model_stats` to the last 5 entries each, so a long history cannot flood the
context window.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `PI_BALANCE_API_KEY` | Use this key instead of `models.json` |
| `PI_BALANCE_BASE_URL` | Gateway base URL for that key (both are required) |
| `PI_BALANCE_PROVIDERS` | Comma-separated provider names, overrides `balance.json` |
| `PI_BALANCE_LOW` | Low-balance threshold, default `5` |

---

## Refresh policy

- Every 5 minutes normally
- Every minute once the **lowest** balance drops below the threshold
- Once at session start, then on demand after each turn
- Accounts are queried in parallel, so the cost is the slowest one, not the sum

---

## Data and privacy

`~/.pi/agent/balance.json` records only which accounts to show. It contains
**no secrets**:

```json
{
  "providers": [
    { "name": "some-provider", "label": "main" },
    { "name": "another-provider", "label": "backup" }
  ]
}
```

`name` must match a provider already present in `models.json`; `label` is the
short footer name and is optional.

Keys stay in `models.json`. This extension **never copies, writes out, or
uploads them**. Queries go only to the gateway URLs you configured yourself.

---

## License

MIT
