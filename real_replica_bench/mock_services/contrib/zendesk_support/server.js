"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const DEFAULT_SEED = path.join(__dirname, "seeds", "default.json");
const STATUSES = new Set(["new", "open", "pending", "hold", "solved", "closed"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const TYPES = new Set(["question", "incident", "problem", "task"]);
const ROLES = new Set(["admin", "agent", "end-user"]);
const TRANSITIONS = {
  new: new Set(["new", "open", "pending", "hold", "solved"]),
  open: new Set(["open", "pending", "hold", "solved"]),
  pending: new Set(["pending", "open", "hold", "solved"]),
  hold: new Set(["hold", "open", "pending", "solved"]),
  solved: new Set(["solved", "open", "closed"]),
  closed: new Set(["closed"]),
};

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function integer(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(422, "invalid_field", `${name} must be an integer`);
  }
  return parsed;
}

function nonEmptyString(value, name, maxLength = 5000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(422, "invalid_field", `${name} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new ApiError(422, "invalid_field", `${name} exceeds ${maxLength} characters`);
  }
  return result;
}

function enumValue(value, name, values) {
  if (!values.has(value)) {
    throw new ApiError(422, "invalid_field", `${name} must be one of: ${[...values].join(", ")}`);
  }
  return value;
}

function normalizedTags(value) {
  if (!Array.isArray(value)) {
    throw new ApiError(422, "invalid_field", "tags must be an array");
  }
  if (value.length > 50) {
    throw new ApiError(422, "invalid_field", "tags cannot contain more than 50 values");
  }
  const tags = value.map((tag) => nonEmptyString(tag, "tag", 64).toLowerCase());
  for (const tag of tags) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(tag)) {
      throw new ApiError(422, "invalid_field", `invalid tag: ${tag}`);
    }
  }
  return [...new Set(tags)].sort();
}

function parseBearer(request) {
  const match = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new ApiError(413, "payload_too_large", "request body exceeds 1 MiB");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json", "request body is not valid JSON");
  }
}

function assertUniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    if (!item || !Number.isSafeInteger(item.id)) {
      throw new ApiError(422, "invalid_seed", `${label} entries require integer ids`);
    }
    if (ids.has(item.id)) {
      throw new ApiError(422, "invalid_seed", `${label} contains duplicate id ${item.id}`);
    }
    ids.add(item.id);
  }
  return ids;
}

function validateSeed(candidate) {
  const state = clone(candidate);
  for (const key of [
    "users",
    "organizations",
    "groups",
    "custom_field_definitions",
    "tickets",
    "comments",
    "audit",
  ]) {
    if (!Array.isArray(state[key])) {
      throw new ApiError(422, "invalid_seed", `${key} must be an array`);
    }
  }
  if (!state.meta || !Number.isSafeInteger(state.meta.next_ids?.ticket) ||
      !Number.isSafeInteger(state.meta.next_ids?.comment) || Number.isNaN(Date.parse(state.meta.clock))) {
    throw new ApiError(422, "invalid_seed", "meta requires clock and integer next_ids");
  }

  const userIds = assertUniqueIds(state.users, "users");
  const organizationIds = assertUniqueIds(state.organizations, "organizations");
  const groupIds = assertUniqueIds(state.groups, "groups");
  const fieldIds = assertUniqueIds(state.custom_field_definitions, "custom_field_definitions");
  const ticketIds = assertUniqueIds(state.tickets, "tickets");
  const commentIds = assertUniqueIds(state.comments, "comments");
  if (state.meta.next_ids.ticket <= Math.max(0, ...ticketIds) ||
      state.meta.next_ids.comment <= Math.max(0, ...commentIds)) {
    throw new ApiError(422, "invalid_seed", "next_ids must be greater than every committed id");
  }

  for (const user of state.users) {
    enumValue(user.role, "user.role", ROLES);
    nonEmptyString(user.name, "user.name", 200);
    nonEmptyString(user.email, "user.email", 320);
    if (typeof user.active !== "boolean") {
      throw new ApiError(422, "invalid_seed", `user ${user.id} active must be boolean`);
    }
    if (user.organization_id != null && !organizationIds.has(user.organization_id)) {
      throw new ApiError(422, "invalid_seed", `user ${user.id} references an unknown organization`);
    }
  }

  for (const ticket of state.tickets) {
    enumValue(ticket.status, "ticket.status", STATUSES);
    enumValue(ticket.priority, "ticket.priority", PRIORITIES);
    enumValue(ticket.type, "ticket.type", TYPES);
    nonEmptyString(ticket.subject, "ticket.subject", 300);
    nonEmptyString(ticket.description, "ticket.description", 10000);
    if (!userIds.has(ticket.requester_id) || !userIds.has(ticket.submitter_id)) {
      throw new ApiError(422, "invalid_seed", `ticket ${ticket.id} references an unknown requester or submitter`);
    }
    if (ticket.assignee_id != null) {
      const assignee = state.users.find((user) => user.id === ticket.assignee_id);
      if (!assignee || !assignee.active || !["admin", "agent"].includes(assignee.role)) {
        throw new ApiError(422, "invalid_seed", `ticket ${ticket.id} references an invalid assignee`);
      }
    }
    if (!groupIds.has(ticket.group_id) || !organizationIds.has(ticket.organization_id)) {
      throw new ApiError(422, "invalid_seed", `ticket ${ticket.id} references an unknown group or organization`);
    }
    normalizedTags(ticket.tags);
    for (const field of ticket.custom_fields || []) {
      if (!fieldIds.has(field.id)) {
        throw new ApiError(422, "invalid_seed", `ticket ${ticket.id} references unknown field ${field.id}`);
      }
    }
  }
  for (const comment of state.comments) {
    if (!ticketIds.has(comment.ticket_id) || !userIds.has(comment.author_id)) {
      throw new ApiError(422, "invalid_seed", `comment ${comment.id} has an unknown ticket or author`);
    }
    nonEmptyString(comment.body, "comment.body", 10000);
    if (typeof comment.public !== "boolean") {
      throw new ApiError(422, "invalid_seed", `comment ${comment.id} public must be boolean`);
    }
  }
  return state;
}

class SupportStore {
  constructor(seed) {
    this.originalSeed = validateSeed(seed);
    this.state = clone(this.originalSeed);
  }

  reset() {
    this.state = clone(this.originalSeed);
    return this.snapshot();
  }

  reseed(seed) {
    this.originalSeed = validateSeed(seed);
    return this.reset();
  }

  snapshot() {
    return clone(this.state);
  }

  transaction(operation) {
    const before = this.snapshot();
    try {
      return operation();
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  tick() {
    const next = new Date(Date.parse(this.state.meta.clock) + 60_000).toISOString();
    this.state.meta.clock = next;
    return next;
  }

  record(action, entityType, entityId, details = {}) {
    const entry = {
      seq: this.state.audit.length + 1,
      at: this.state.meta.clock,
      action,
      entity_type: entityType,
      entity_id: entityId,
      details: clone(details),
    };
    this.state.audit.push(entry);
    return entry;
  }

  user(id, { role } = {}) {
    const user = this.state.users.find((item) => item.id === id && item.active);
    if (!user || (role && !role.has(user.role))) {
      throw new ApiError(422, "invalid_reference", `unknown or inactive user ${id}`);
    }
    return user;
  }

  ticket(id) {
    const ticket = this.state.tickets.find((item) => item.id === id);
    if (!ticket) throw new ApiError(404, "record_not_found", `ticket ${id} was not found`);
    return ticket;
  }

  validateOrganization(id) {
    if (!this.state.organizations.some((item) => item.id === id)) {
      throw new ApiError(422, "invalid_reference", `unknown organization ${id}`);
    }
    return id;
  }

  validateGroup(id) {
    if (!this.state.groups.some((item) => item.id === id)) {
      throw new ApiError(422, "invalid_reference", `unknown group ${id}`);
    }
    return id;
  }

  customFields(fields) {
    if (!Array.isArray(fields)) {
      throw new ApiError(422, "invalid_field", "custom_fields must be an array");
    }
    const definitions = new Map(this.state.custom_field_definitions.map((item) => [item.id, item]));
    const seen = new Set();
    const result = [];
    for (const raw of fields) {
      const id = integer(raw?.id, "custom_fields.id");
      const definition = definitions.get(id);
      if (!definition || seen.has(id)) {
        throw new ApiError(422, "invalid_field", `unknown or duplicate custom field ${id}`);
      }
      seen.add(id);
      let value = raw.value;
      if (definition.type === "order-id") {
        value = nonEmptyString(value, definition.name, 20).toUpperCase();
        if (!/^ORD-[0-9]{5}$/.test(value)) {
          throw new ApiError(422, "invalid_field", `${definition.name} must match ORD-12345`);
        }
      } else if (definition.type === "enum") {
        if (!definition.options.includes(value)) {
          throw new ApiError(422, "invalid_field", `${definition.name} must be one of: ${definition.options.join(", ")}`);
        }
      } else if (definition.type === "amount") {
        value = Number(value);
        if (!Number.isFinite(value) || value < 0 || value > 100000 ||
            Math.abs(Math.round(value * 100) - value * 100) > 1e-9) {
          throw new ApiError(422, "invalid_field", `${definition.name} must be a non-negative amount with at most two decimals`);
        }
      }
      result.push({ id, value });
    }
    return result.sort((left, right) => left.id - right.id);
  }

  comment(ticket, raw, defaultAuthorId) {
    if (!raw) return null;
    const body = nonEmptyString(raw.body, "comment.body", 10000);
    const authorId = integer(raw.author_id ?? defaultAuthorId, "comment.author_id");
    this.user(authorId);
    if (raw.public !== undefined && typeof raw.public !== "boolean") {
      throw new ApiError(422, "invalid_field", "comment.public must be boolean");
    }
    const comment = {
      id: this.state.meta.next_ids.comment++,
      ticket_id: ticket.id,
      author_id: authorId,
      body,
      public: raw.public !== false,
      created_at: this.state.meta.clock,
    };
    this.state.comments.push(comment);
    return comment;
  }

  createTicket(raw) {
    const allowed = new Set([
      "subject", "description", "status", "priority", "type", "requester_id",
      "submitter_id", "assignee_id", "group_id", "organization_id", "tags",
      "custom_fields", "via", "comment",
    ]);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new ApiError(422, "invalid_field", `unknown ticket fields: ${unknown.join(", ")}`);
    }
    const requesterId = integer(raw.requester_id, "requester_id");
    const submitterId = integer(raw.submitter_id ?? requesterId, "submitter_id");
    const requester = this.user(requesterId);
    this.user(submitterId);
    const assigneeId = raw.assignee_id == null ? null : integer(raw.assignee_id, "assignee_id");
    if (assigneeId != null) this.user(assigneeId, { role: new Set(["admin", "agent"]) });
    const organizationId = integer(raw.organization_id ?? requester.organization_id, "organization_id");
    this.validateOrganization(organizationId);
    const groupId = integer(raw.group_id, "group_id");
    this.validateGroup(groupId);
    const description = raw.description ?? raw.comment?.body;
    const channel = raw.via?.channel ?? "api";
    if (!["api", "email", "web"].includes(channel)) {
      throw new ApiError(422, "invalid_field", "via.channel must be api, email, or web");
    }
    const at = this.tick();
    const ticket = {
      id: this.state.meta.next_ids.ticket++,
      subject: nonEmptyString(raw.subject, "subject", 300),
      description: nonEmptyString(description, "description", 10000),
      status: enumValue(raw.status ?? "new", "status", STATUSES),
      priority: enumValue(raw.priority ?? "normal", "priority", PRIORITIES),
      type: enumValue(raw.type ?? "question", "type", TYPES),
      requester_id: requesterId,
      submitter_id: submitterId,
      assignee_id: assigneeId,
      group_id: groupId,
      organization_id: organizationId,
      tags: normalizedTags(raw.tags ?? []),
      custom_fields: this.customFields(raw.custom_fields ?? []),
      via: { channel },
      created_at: at,
      updated_at: at,
    };
    this.state.tickets.push(ticket);
    this.comment(ticket, raw.comment || { body: ticket.description, public: true }, submitterId);
    this.record("ticket.created", "ticket", ticket.id, { status: ticket.status });
    return clone(ticket);
  }

  updateTicket(id, raw) {
    const ticket = this.ticket(id);
    if (ticket.status === "closed") {
      throw new ApiError(409, "ticket_closed", "closed tickets are immutable");
    }
    if (!Object.keys(raw).length) {
      throw new ApiError(422, "invalid_request", "ticket update cannot be empty");
    }
    const before = clone(ticket);
    if (raw.status !== undefined) {
      enumValue(raw.status, "status", STATUSES);
      if (!TRANSITIONS[ticket.status].has(raw.status)) {
        throw new ApiError(409, "invalid_transition", `cannot transition ${ticket.status} to ${raw.status}`);
      }
      ticket.status = raw.status;
    }
    if (raw.subject !== undefined) ticket.subject = nonEmptyString(raw.subject, "subject", 300);
    if (raw.priority !== undefined) ticket.priority = enumValue(raw.priority, "priority", PRIORITIES);
    if (raw.type !== undefined) ticket.type = enumValue(raw.type, "type", TYPES);
    if (raw.requester_id !== undefined) {
      ticket.requester_id = integer(raw.requester_id, "requester_id");
      this.user(ticket.requester_id);
    }
    if (raw.assignee_id !== undefined) {
      ticket.assignee_id = integer(raw.assignee_id, "assignee_id", { nullable: true });
      if (ticket.assignee_id != null) this.user(ticket.assignee_id, { role: new Set(["admin", "agent"]) });
    }
    if (raw.organization_id !== undefined) {
      ticket.organization_id = integer(raw.organization_id, "organization_id");
      this.validateOrganization(ticket.organization_id);
    }
    if (raw.group_id !== undefined) {
      ticket.group_id = integer(raw.group_id, "group_id");
      this.validateGroup(ticket.group_id);
    }
    if (raw.tags !== undefined) ticket.tags = normalizedTags(raw.tags);
    if (raw.custom_fields !== undefined) ticket.custom_fields = this.customFields(raw.custom_fields);

    const allowed = new Set([
      "status", "subject", "priority", "type", "requester_id", "assignee_id",
      "organization_id", "group_id", "tags", "custom_fields", "comment",
    ]);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new ApiError(422, "invalid_field", `unknown ticket fields: ${unknown.join(", ")}`);
    }

    ticket.updated_at = this.tick();
    const comment = this.comment(ticket, raw.comment, ticket.assignee_id ?? ticket.submitter_id);
    const changed = Object.keys(ticket).filter((key) => JSON.stringify(ticket[key]) !== JSON.stringify(before[key]));
    this.record("ticket.updated", "ticket", ticket.id, {
      changed_fields: changed.sort(),
      comment_id: comment?.id ?? null,
    });
    return clone(ticket);
  }
}

function loadSeed(seedPath) {
  return JSON.parse(fs.readFileSync(seedPath, "utf8"));
}

function createSupportServer(options = {}) {
  const agentToken = options.agentToken ?? process.env.SUPPORT_API_TOKEN ?? "local-agent-token";
  const verifierToken = options.verifierToken ?? process.env.MOCK_VERIFIER_TOKEN ?? "bench-verifier";
  const seedPath = options.seedPath ?? process.env.SUPPORT_MOCK_SEED ?? DEFAULT_SEED;
  const store = new SupportStore(options.seed ?? loadSeed(seedPath));

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: "zendesk_support", seed_version: store.state.meta.seed_version });
      }

      const isBench = url.pathname.startsWith("/__bench/");
      const token = parseBearer(request);
      if (isBench) {
        if (!verifierToken || token !== verifierToken) {
          throw new ApiError(token ? 403 : 401, "access_denied", "invalid or missing verifier token");
        }
      } else if (!agentToken || token !== agentToken) {
        throw new ApiError(token ? 403 : 401, "access_denied", "invalid or missing API token");
      }

      if (request.method === "GET" && url.pathname === "/__bench/state") {
        return sendJson(response, 200, { state: store.snapshot() });
      }
      if (request.method === "GET" && url.pathname === "/__bench/audit") {
        return sendJson(response, 200, { audit: clone(store.state.audit) });
      }
      if (request.method === "POST" && url.pathname === "/__bench/reset") {
        return sendJson(response, 200, { state: store.reset() });
      }
      if (request.method === "POST" && url.pathname === "/__bench/seed") {
        const body = await readJson(request);
        return sendJson(response, 200, { state: store.reseed(body.state ?? body) });
      }

      if (request.method === "GET" && url.pathname === "/api/v2/users.json") {
        return sendJson(response, 200, { users: clone(store.state.users) });
      }
      if (request.method === "GET" && url.pathname === "/api/v2/organizations.json") {
        return sendJson(response, 200, { organizations: clone(store.state.organizations) });
      }
      if (request.method === "GET" && url.pathname === "/api/v2/groups.json") {
        return sendJson(response, 200, { groups: clone(store.state.groups) });
      }
      if (request.method === "GET" && url.pathname === "/api/v2/ticket_fields.json") {
        return sendJson(response, 200, { ticket_fields: clone(store.state.custom_field_definitions) });
      }

      if (request.method === "GET" && url.pathname === "/api/v2/tickets.json") {
        let tickets = clone(store.state.tickets);
        for (const field of ["status", "priority", "type"]) {
          if (url.searchParams.has(field)) tickets = tickets.filter((item) => item[field] === url.searchParams.get(field));
        }
        for (const field of ["assignee_id", "requester_id", "organization_id", "group_id"]) {
          if (url.searchParams.has(field)) {
            const id = integer(url.searchParams.get(field), field);
            tickets = tickets.filter((item) => item[field] === id);
          }
        }
        if (url.searchParams.has("tag")) tickets = tickets.filter((item) => item.tags.includes(url.searchParams.get("tag").toLowerCase()));
        const sortBy = url.searchParams.get("sort_by") ?? "id";
        if (!["id", "created_at", "updated_at", "priority", "status"].includes(sortBy)) {
          throw new ApiError(422, "invalid_parameter", "unsupported sort_by value");
        }
        const direction = url.searchParams.get("sort_order") === "desc" ? -1 : 1;
        tickets.sort((left, right) => (left[sortBy] < right[sortBy] ? -direction : left[sortBy] > right[sortBy] ? direction : left.id - right.id));
        const page = Math.max(1, integer(url.searchParams.get("page") ?? 1, "page"));
        const perPage = Math.min(100, Math.max(1, integer(url.searchParams.get("per_page") ?? 100, "per_page")));
        const start = (page - 1) * perPage;
        return sendJson(response, 200, {
          tickets: tickets.slice(start, start + perPage),
          count: tickets.length,
          page,
          per_page: perPage,
          next_page: start + perPage < tickets.length ? page + 1 : null,
        });
      }

      const ticketMatch = url.pathname.match(/^\/api\/v2\/tickets\/(\d+)\.json$/);
      if (ticketMatch && request.method === "GET") {
        const ticket = store.ticket(Number(ticketMatch[1]));
        const comments = store.state.comments.filter((item) => item.ticket_id === ticket.id);
        return sendJson(response, 200, { ticket: clone(ticket), comments: clone(comments) });
      }
      if (ticketMatch && request.method === "PUT") {
        const body = await readJson(request);
        if (!body.ticket || typeof body.ticket !== "object" || Array.isArray(body.ticket)) {
          throw new ApiError(422, "invalid_request", "body.ticket must be an object");
        }
        const ticket = store.transaction(() => store.updateTicket(Number(ticketMatch[1]), body.ticket));
        return sendJson(response, 200, { ticket });
      }
      if (request.method === "POST" && url.pathname === "/api/v2/tickets.json") {
        const body = await readJson(request);
        if (!body.ticket || typeof body.ticket !== "object" || Array.isArray(body.ticket)) {
          throw new ApiError(422, "invalid_request", "body.ticket must be an object");
        }
        const ticket = store.transaction(() => store.createTicket(body.ticket));
        return sendJson(response, 201, { ticket });
      }

      if (request.method === "GET" && url.pathname === "/api/v2/search.json") {
        const query = nonEmptyString(url.searchParams.get("query"), "query", 200).toLowerCase();
        const results = store.state.tickets.filter((ticket) => {
          const haystack = [ticket.subject, ticket.description, ...ticket.tags, ...ticket.custom_fields.map((field) => field.value)].join(" ").toLowerCase();
          return haystack.includes(query);
        }).map((ticket) => ({ ...clone(ticket), result_type: "ticket" }));
        return sendJson(response, 200, { results, count: results.length });
      }

      throw new ApiError(404, "route_not_found", `${request.method} ${url.pathname} is not implemented`);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      const payload = {
        error: error instanceof ApiError ? error.code : "internal_error",
        description: error instanceof ApiError ? error.message : "internal server error",
      };
      if (error instanceof ApiError && error.details !== undefined) payload.details = error.details;
      if (!(error instanceof ApiError)) console.error(error);
      if (!response.headersSent) sendJson(response, status, payload);
      else response.end();
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3117);
  const host = process.env.HOST || "127.0.0.1";
  const server = createSupportServer();
  server.listen(port, host, () => {
    console.log(`zendesk_support mock listening on http://${host}:${port}`);
  });
}

module.exports = { ApiError, SupportStore, createSupportServer, validateSeed };
