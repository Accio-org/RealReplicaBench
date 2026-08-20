"use strict";

const assert = require("node:assert/strict");
const { after, before, beforeEach, test } = require("node:test");
const { createSupportServer } = require("./server");

const AGENT_TOKEN = "test-agent-token";
const VERIFIER_TOKEN = "test-verifier-token";
let baseUrl;
let server;

async function request(path, { method = "GET", body, token = AGENT_TOKEN } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: token ? `Bearer ${token}` : "",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json() };
}

before(async () => {
  server = createSupportServer({ agentToken: AGENT_TOKEN, verifierToken: VERIFIER_TOKEN });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(async () => {
  const { response } = await request("/__bench/reset", { method: "POST", token: VERIFIER_TOKEN });
  assert.equal(response.status, 200);
});

test("health is public and agent/verifier surfaces use distinct tokens", async () => {
  const health = await request("/health", { token: "" });
  assert.equal(health.response.status, 200);
  assert.equal(health.json.service, "zendesk_support");

  assert.equal((await request("/api/v2/tickets.json", { token: "" })).response.status, 401);
  assert.equal((await request("/api/v2/tickets.json", { token: VERIFIER_TOKEN })).response.status, 403);
  assert.equal((await request("/__bench/state", { token: AGENT_TOKEN })).response.status, 403);
});

test("ticket list filters, paginates, and searches deterministically", async () => {
  const filtered = await request("/api/v2/tickets.json?status=open&tag=damage&per_page=1");
  assert.equal(filtered.response.status, 200);
  assert.equal(filtered.json.count, 1);
  assert.equal(filtered.json.tickets[0].id, 1001);
  assert.equal(filtered.json.next_page, null);

  const searched = await request("/api/v2/search.json?query=ORD-40988");
  assert.equal(searched.response.status, 200);
  assert.deepEqual(searched.json.results.map((item) => item.id), [1003]);
});

test("creating a ticket assigns deterministic ids, timestamps, and audit evidence", async () => {
  const created = await request("/api/v2/tickets.json", {
    method: "POST",
    body: {
      ticket: {
        subject: "Missing bottle cage from order",
        description: "The parcel did not include the bottle cage.",
        requester_id: 201,
        assignee_id: 102,
        group_id: 401,
        priority: "high",
        tags: ["Order", "missing_item", "order"],
        custom_fields: [
          { id: 9001, value: "ord-41031" },
          { id: 9002, value: "missing-item" }
        ]
      }
    }
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.json.ticket.id, 1006);
  assert.equal(created.json.ticket.created_at, "2026-08-01T09:01:00.000Z");
  assert.deepEqual(created.json.ticket.tags, ["missing_item", "order"]);

  const state = await request("/__bench/state", { token: VERIFIER_TOKEN });
  assert.equal(state.json.state.comments.at(-1).id, 5010);
  assert.deepEqual(state.json.state.audit.at(-1), {
    seq: 1,
    at: "2026-08-01T09:01:00.000Z",
    action: "ticket.created",
    entity_type: "ticket",
    entity_id: 1006,
    details: { status: "new" }
  });
});

test("invalid creates are atomic and unknown fields are rejected", async () => {
  const before = await request("/__bench/state", { token: VERIFIER_TOKEN });
  const invalid = await request("/api/v2/tickets.json", {
    method: "POST",
    body: {
      ticket: {
        subject: "Unsupported payload",
        description: "This request includes an undeclared field.",
        requester_id: 201,
        group_id: 401,
        severity: "critical"
      }
    }
  });
  assert.equal(invalid.response.status, 422);
  assert.equal(invalid.json.error, "invalid_field");
  const after = await request("/__bench/state", { token: VERIFIER_TOKEN });
  assert.deepEqual(after.json.state, before.json.state);
});

test("updates enforce references and record comments through the verifier readout", async () => {
  const beforeInvalid = await request("/__bench/state", { token: VERIFIER_TOKEN });
  const invalid = await request("/api/v2/tickets/1005.json", {
    method: "PUT",
    body: { ticket: { assignee_id: 201 } }
  });
  assert.equal(invalid.response.status, 422);
  assert.equal(invalid.json.error, "invalid_reference");
  const afterInvalid = await request("/__bench/state", { token: VERIFIER_TOKEN });
  assert.deepEqual(afterInvalid.json.state, beforeInvalid.json.state);

  const updated = await request("/api/v2/tickets/1005.json", {
    method: "PUT",
    body: {
      ticket: {
        status: "open",
        assignee_id: 103,
        tags: ["billing", "receipt", "expense"],
        comment: { body: "Receipt export is in progress.", public: false, author_id: 103 }
      }
    }
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.json.ticket.status, "open");
  assert.equal(updated.json.ticket.updated_at, "2026-08-01T09:01:00.000Z");

  const state = await request("/__bench/state", { token: VERIFIER_TOKEN });
  assert.equal(state.json.state.comments.at(-1).body, "Receipt export is in progress.");
  assert.equal(state.json.state.comments.at(-1).public, false);
  assert.equal(state.json.state.audit.at(-1).details.comment_id, 5010);
  assert.deepEqual(state.json.state.audit.at(-1).details.changed_fields,
    ["assignee_id", "status", "tags", "updated_at"]);
});

test("status transitions and closed-ticket immutability are server-side rules", async () => {
  const badTransition = await request("/api/v2/tickets/1001.json", {
    method: "PUT",
    body: { ticket: { status: "closed" } }
  });
  assert.equal(badTransition.response.status, 409);
  assert.equal(badTransition.json.error, "invalid_transition");

  assert.equal((await request("/api/v2/tickets/1004.json", {
    method: "PUT",
    body: { ticket: { status: "closed" } }
  })).response.status, 200);

  const immutable = await request("/api/v2/tickets/1004.json", {
    method: "PUT",
    body: { ticket: { subject: "Try to mutate a closed ticket" } }
  });
  assert.equal(immutable.response.status, 409);
  assert.equal(immutable.json.error, "ticket_closed");
});

test("verifier reset restores an exact seed snapshot", async () => {
  const original = await request("/__bench/state", { token: VERIFIER_TOKEN });
  await request("/api/v2/tickets/1001.json", {
    method: "PUT",
    body: { ticket: { priority: "urgent" } }
  });
  const reset = await request("/__bench/reset", { method: "POST", token: VERIFIER_TOKEN });
  assert.deepEqual(reset.json.state, original.json.state);
});
