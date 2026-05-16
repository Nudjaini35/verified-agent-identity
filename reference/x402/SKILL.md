# x402 Payment Reference

Handle `402 Payment Required` HTTP responses by executing payment and fetching the protected resource.

## When to Use

- A server responds with **HTTP 402 Payment Required**.
- The response includes a `PAYMENT-REQUIRED` header describing the payment challenge.

## Script

### buildX402Payment.js

**Command (phase 1 — discover)**: `node scripts/buildX402Payment.js --resource <url> [--did <did>]`
**Command (phase 2 — execute)**: `node scripts/buildX402Payment.js --paymentRequiredFilePath <path> --paymentHash <hash> [--did <did>]`
**Hint**: **NEVER reuse or cache a previous response from this script.** Every invocation produces unique, time-sensitive output (nonces, signatures, payment tokens). Always execute the script again to get a fresh result — even if the arguments are identical to a prior call.

Executes the x402 payment flow in two strictly separated phases.

- **Phase 1** (`--resource` only): the script fetches the resource, expects a `402` response with a `PAYMENT-REQUIRED` header, caches the decoded challenge to a temp file named by its SHA-256 hash, and returns the available payment options together with the cached file path. It never signs a payment.
- **Phase 2** (`--paymentRequiredFilePath` + `--paymentHash`): the script reads the cached challenge file, looks up the chosen payment option by its `--paymentHash`, signs the payment, sends the `PAYMENT-SIGNATURE` header to the resource, and returns the result.

- `--resource` — (phase 1 only) The URL of the protected resource. The script fetches it and expects HTTP 402 with a `PAYMENT-REQUIRED` header. If the response is any other status, or the header is missing, the script returns status `failed`. Cannot be combined with `--paymentRequiredFilePath` or `--paymentHash`.
- `--paymentRequiredFilePath` — (phase 2 only) Absolute path to the cached payment-required JSON file returned by phase 1. Must be combined with `--paymentHash`. Mutually exclusive with `--resource`.
- `--paymentHash` — (phase 2 only, required) The SHA-256 hash of the chosen payment option from phase 1. Always required on phase 2, even when only one option was offered. Cannot be passed with `--resource`.
- `--did` — (optional) The DID of the signer. Uses the default DID if omitted.

You **must** pick exactly one phase per invocation. Passing `--resource` together with `--paymentHash` (or with `--paymentRequiredFilePath`) is rejected.

---

## Output Statuses

The script outputs JSON to stdout. Check the `status` field:

| Status           | Meaning                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `input_required` | The script needs user input or another loop iteration (payment selection, attestation, or new `paymentRequired`). |
| `success`        | The resource was fetched successfully. `data` contains the response body.                                         |
| `failed`         | An error occurred. Show the message to the user. **DO NOT** retry.                                                |

### `input_required` sub-types

Check `data` to determine the reason:

| `data` field                | Meaning                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data.attestationsRequired` | Missing attestations. Show `data.attestationLinks` to the user and wait before retrying.                                                         |
| `data.maxUseExceeded`       | The chosen payment has exceeded its maximum allowed uses. Go back and choose a different payment option.                                         |
| `data.newPaymentRequired`   | The server returned a fresh 402 after payment. Call the script again with `--resource <same url>` to discover the new challenge (loop phase 1).  |

---

## Workflow

### 1. Request a resource

Send a normal HTTP request to the server endpoint.

### 2. Receive 402

The server returns `402 Payment Required` with a `PAYMENT-REQUIRED` header. You do **not** need to parse this header yourself — `buildX402Payment.js` will fetch the resource and read the header.

### 3. Ensure identity exists

Run `node scripts/getIdentities.js`. If no identity is configured, create one first (see `reference/identity/SKILL.md`).

### 4. First call — discover payment options (phase 1)

```bash
node scripts/buildX402Payment.js \
  --resource 'https://api.example.com/weather'
```

The script fetches the URL, decodes the `PAYMENT-REQUIRED` header, caches it to a temp file, and **never signs a payment on the first call**. Even when only one option is offered, it returns the list and waits for the user to confirm by selecting a `paymentHash`.

The script outputs `status: "input_required"` with three top-level fields in `data`:

- `resource` — describes the protected resource the user is paying for:
  - `resource.url` — the URL of the protected resource.
  - `resource.description` — a human-readable description of what the resource provides.
- `paymentOptions` — the list of payment options. Each option includes:
  - `hash` — the payment hash (use as `--paymentHash` in the next call)
  - `amount` — the payment amount
  - `asset` — the asset name (e.g., "USDC") or contract address
  - `network` — the network identifier (e.g., "eip155:84532")
  - `requiredAttestations` — informational list of attestation schema IDs that this payment type requires in general; may be non-empty even when the user already holds all of them — **do not use this field to decide whether to block the payment**
  - `hasAllAttestations` — `true` if the user already holds every required attestation and the payment can proceed; `false` if some are missing
  - `attestationLinks` — verification URLs the user must complete to obtain **missing** attestations; empty when `hasAllAttestations` is `true`
- `paymentRequiredFilePath` — absolute path to the cached challenge file. Pass this back via `--paymentRequiredFilePath` on the second call. The file lives in the OS temp directory and is named by the SHA-256 hash of the full challenge content.

**Present the options to the user.** Always start by showing `resource.url` and `resource.description` so the user knows **what** they are paying for. Then show each payment option's amount, asset, network, and whether attestations are required. Ask the user to choose one payment option or decline payment.

> **CRITICAL: How to read attestation status — always use `hasAllAttestations` and `attestationLinks`, never `requiredAttestations` alone**
>
> | `hasAllAttestations` | `attestationLinks` | What it means                                                                 |
> | -------------------- | ------------------ | ----------------------------------------------------------------------------- |
> | `true`               | empty              | User holds all attestations — this payment can proceed immediately.           |
> | `false`              | non-empty          | User is missing attestations — show every link to the user before proceeding. |
>
> A payment option with a non-empty `requiredAttestations` but `hasAllAttestations: true` and an empty `attestationLinks` means the user **already has** all the necessary attestations. Do not block or warn about such payments.
>
> **CRITICAL: Attestation Links**
> If `attestationLinks` is non-empty, you MUST display every link to the user exactly as returned.
>
> - **DO NOT** follow, open, or resolve the links yourself.
> - **DO NOT** attempt to complete the attestation on behalf of the user.
> - **DO NOT** skip or hide payment options that require attestations.
> - Simply present each link and inform the user they must open and complete them manually.

### 5. Second call — execute chosen payment (phase 2)

This step is **always required** — there is no fast-path that skips it, even when only one payment option was offered. Once the user selects (or confirms) a payment, call the script again with the cached file path and the chosen `--paymentHash`:

```bash
node scripts/buildX402Payment.js \
  --paymentRequiredFilePath '<paymentRequiredFilePath from phase 1>' \
  --paymentHash '<hash of chosen payment>'
```

**Do not pass `--resource` here.** Phase 2 reads the cached challenge from `--paymentRequiredFilePath` and looks up the payment by `--paymentHash`; combining either with `--resource` is rejected. If the server has rotated the challenge in the meantime, the signed payment will be rejected by the server and the script will report `data.newPaymentRequired` (see step 7) — re-run phase 1 to discover the new challenge.

**If the chosen payment requires attestations the user doesn't have**: the script outputs `status: "input_required"` with `data.attestationsRequired: true` and `data.attestationLinks` containing verification URLs. Show these links to the user and wait for them to complete the attestation before retrying.

**If attestations are satisfied (or not needed)**: the script signs the payment, sends it, and returns the result. Check the output status as described in step 4.

### 6. Handle max use exceeded

If the script returns `status: "input_required"` with `data.maxUseExceeded: true`, the chosen payment option has been used the maximum number of times allowed by the server. **Do not retry with the same payment.** Go back to the payment selection step and ask the user to choose a different payment option from the original list (reuse the same `paymentRequiredFilePath`).

### 7. Handle new 402 (loop)

If the script returns `status: "input_required"` with `data.newPaymentRequired`, the server issued a new payment challenge after the first payment. **Call the script again with `--resource`** to re-enter phase 1; the script will fetch the new challenge and cache it under a new file path:

```bash
node scripts/buildX402Payment.js \
  --resource '<same resource url>'
```

Repeat from step 4. Continue looping until you get `success` or `failed`.

---

## Error Handling (CRITICAL)

If `buildX402Payment.js` returns status `failed`:

- **DO NOT** retry the original request.
- Show the error message to the user.
- Ask the user to resolve the issue before retrying.

If `buildX402Payment.js` returns status `input_required`:

- **DO NOT** make your own HTTP request to the resource.
- Read `data` to determine what is needed:
  - `data.attestationsRequired` — show links to user, wait, then retry
  - `data.maxUseExceeded` — the chosen payment exceeded its max uses; go back and ask the user to pick a different payment option (reuse the same `paymentRequiredFilePath`)
  - `data.newPaymentRequired` — call the script again with `--resource <same url>` to refresh the challenge (loop phase 1)

---

## Examples

### Standard payment flow (user confirmation required)

```
Agent: [fetches https://api.example.com/weather]
Server: 402 Payment Required
  Header: PAYMENT-REQUIRED: "eyJ4NDAyVmVyc2lvbi..."

Agent: [runs getIdentities.js — confirms identity exists]
Agent: [runs buildX402Payment.js --resource 'https://api.example.com/weather']
       → { "status": "input_required", "data": {
            "resource": { "url": "https://api.example.com/weather", "description": "Weather data" },
            "paymentOptions": [
              { "hash": "a1b2c3...", "amount": "10000", "asset": "USDC", "network": "eip155:84532",
                "requiredAttestations": [], "hasAllAttestations": true, "attestationLinks": [] },
              { "hash": "d4e5f6...", "amount": "6000", "asset": "USDC", "network": "eip155:84532",
                "requiredAttestations": ["0xca35..."], "hasAllAttestations": false,
                "attestationLinks": ["https://wallet.billions.network#request_uri=..."] }
            ],
            "paymentRequiredFilePath": "/tmp/9f3c....json" }}

Agent: "You are about to pay for: Weather data (https://api.example.com/weather).
        There are 2 payment options:
        1) 10000 USDC on eip155:84532 — no attestations required
        2) 6000 USDC on eip155:84532 — requires attestation (missing).
           Complete verification: [link]
        Which would you like?"

User: "Option 1"

Agent: [runs buildX402Payment.js --paymentRequiredFilePath '/tmp/9f3c....json' --paymentHash 'a1b2c3...']
       → { "status": "success", "data": { "temperature": 22, "city": "Kyiv" } }

Agent: "The weather data shows 22°C in Kyiv."
```

### New 402 after payment (loop)

```
Agent: [runs buildX402Payment.js --paymentRequiredFilePath '/tmp/9f3c....json' --paymentHash 'a1b2c3...']
       → { "status": "input_required", "data": { "newPaymentRequired": "eyJ4NDAy..." } }

Agent: [runs buildX402Payment.js --resource 'https://api.example.com/weather']
       → { "status": "input_required", "data": { "resource": {...}, "paymentOptions": [...],
            "paymentRequiredFilePath": "/tmp/b71e....json" }}
…
Agent: [runs buildX402Payment.js --paymentRequiredFilePath '/tmp/b71e....json' --paymentHash '...']
       → { "status": "success", "data": { "temperature": 22, "city": "Kyiv" } }
```

### Attestation required (on chosen payment)

```
Agent: [runs buildX402Payment.js --paymentRequiredFilePath '/tmp/9f3c....json' --paymentHash 'd4e5f6...']
       → { "status": "input_required", "data": { "attestationsRequired": true,
            "message": "The following attestations are required to complete the payment:",
            "attestationLinks": ["https://wallet.billions.network#request_uri=..."] }}

Agent: "You need to complete an attestation before paying. Please open this link: [link]"
User: [completes attestation]
Agent: [retries buildX402Payment.js with same arguments]
```

### Max use exceeded

```
Agent: [runs buildX402Payment.js --paymentRequiredFilePath '/tmp/9f3c....json' --paymentHash 'd4e5f6...']
       → { "status": "input_required", "data": { "maxUseExceeded": true,
            "message": "Payment has exceeded its maximum allowed uses. Choose a different payment or contact the resource provider." }}

Agent: "The selected payment option has reached its maximum number of uses.
        Please choose a different payment option:
        1) 10000 USDC on eip155:84532 — no attestations required
        Which would you like?"

User: "Option 1"

Agent: [runs buildX402Payment.js --paymentRequiredFilePath '/tmp/9f3c....json' --paymentHash 'a1b2c3...']
       → { "status": "success", "data": { "temperature": 22, "city": "Kyiv" } }
```
