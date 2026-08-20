# Zendesk Support API mock

This directory contains an original, deterministic, offline replica of a useful
subset of the Zendesk Support ticket API. It is intended for benchmark tasks in
which an agent must triage customer-support work: search tickets, assign an
agent or group, apply tags, add public or internal comments, and move a ticket
through a valid status workflow.

The implementation is not affiliated with or endorsed by Zendesk. It contains
no Zendesk code, captured responses, logos, fonts, screenshots, or other
third-party assets. All names, accounts, tickets, and messages in the committed
seed are synthetic and use the reserved `.test` top-level domain.

## Runtime contract

- Requested port: `3117` (override with `PORT`)
- Bind address: `127.0.0.1` (override with `HOST`)
- Health check: `GET /health`
- Launcher: `node /opt/mock_services/zendesk_support/server.js`
- Agent authentication: `Authorization: Bearer $SUPPORT_API_TOKEN`
- Verifier readout: `GET /__bench/state` with
  `Authorization: Bearer $MOCK_VERIFIER_TOKEN`
- Seed override: `SUPPORT_MOCK_SEED=/absolute/path/to/seed.json`

Standalone development defaults are `local-agent-token` and `bench-verifier`.
A benchmark task should always inject different task-local values and expose
only `SUPPORT_API_TOKEN` to the agent.

The server has no package dependencies and makes no network requests. Every
mutation advances a seed-owned logical clock by exactly one minute. IDs come
from committed counters, so the same seed plus the same sequence of requests
produces byte-for-byte identical state and audit entries.

## Agent API

The mock implements JSON endpoints under `/api/v2/`:

| Method and path | Behavior |
|---|---|
| `GET /tickets.json` | List, filter, sort, and paginate tickets |
| `GET /tickets/:id.json` | Read one ticket and its comments |
| `POST /tickets.json` | Create a ticket and initial comment |
| `PUT /tickets/:id.json` | Assign, classify, tag, comment, or change status |
| `GET /search.json?query=...` | Search subject, description, tags, and custom fields |
| `GET /users.json` | List synthetic users and roles |
| `GET /organizations.json` | List synthetic customer organizations |
| `GET /groups.json` | List support groups |
| `GET /ticket_fields.json` | Discover closed-set custom-field definitions |

Ticket status, priority, type, assignee role, group, organization, tags, custom
fields, and status transitions are validated on the server. In particular,
`closed` tickets are immutable, and a ticket cannot jump directly from `open`
to `closed`. These rules apply to raw HTTP clients as well as future UIs.

Example:

```bash
curl -sS http://127.0.0.1:3117/api/v2/tickets.json?status=new \
  -H 'Authorization: Bearer local-agent-token'

curl -sS -X PUT http://127.0.0.1:3117/api/v2/tickets/1005.json \
  -H 'Authorization: Bearer local-agent-token' \
  -H 'Content-Type: application/json' \
  --data '{"ticket":{"assignee_id":103,"status":"open","comment":{"body":"I am preparing the receipt.","public":true}}}'
```

## Verifier and seed shape

`GET /__bench/state` returns the full authoritative state, including users,
organizations, groups, custom-field definitions, tickets, comments, the logical
clock and next-ID counters, and an append-only mutation audit. Verifiers should
score this readout rather than agent output.

Verifier-only control routes are:

- `GET /__bench/audit`
- `POST /__bench/reset`
- `POST /__bench/seed` with either a state object or `{ "state": ... }`

The committed seed is [`seeds/default.json`](seeds/default.json). A task-specific
seed must preserve the same top-level arrays and metadata. Seed loading checks
duplicate IDs, enum values, required text, and all ticket/comment references
before the server accepts the state.

## Local validation

```bash
cd real_replica_bench/mock_services/contrib/zendesk_support
npm test
PORT=3117 SUPPORT_API_TOKEN=local-agent-token \
  MOCK_VERIFIER_TOKEN=bench-verifier npm start
```

The integration tests exercise authentication separation, filtering and search,
deterministic create/update behavior, invalid references, status transitions,
closed-ticket immutability, audit evidence, and exact reset behavior.
