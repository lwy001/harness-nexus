#!/usr/bin/env node
/**
 * Fixture ACP agent (Phase 8 C5 tests + smoke). Speaks ACP v1 — JSON-RPC 2.0,
 * newline-delimited — over stdio:
 *
 *   initialize → {protocolVersion: 1, agentInfo: {name: 'fixture-agent'}}
 *   session/new → {sessionId, cwd}
 *   session/prompt →
 *     prompt containing 'ask-permission':
 *        session/request_permission (a REQUEST, answered by the client) →
 *        allow_*: tool_call completed + "permission granted: <optionId>" → end_turn
 *        reject_* or cancelled: tool_call failed + "denied" → end_turn
 *     any other prompt: one thought chunk + one text chunk (echo) + usage → end_turn
 *   session/cancel → the pending prompt resolves {stopReason: 'cancelled'}
 *   session/close → {}
 *
 * The daemon tests drive it via HN_ACP_COMMAND_<TARGET>="node <this file>".
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

/** Pending permission waiters: jsonrpc request id → (outcome) => void */
const permissionWaiters = new Map();
/** In-flight prompt ids — session/cancel resolves all of them as 'cancelled'. */
const promptIds = new Set();

let nextId = 1;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function update(sessionId, sessionUpdate) {
  notify('session/update', { sessionId, update: { sessionUpdate, ...(sessionUpdate === 'usage_update' ? { usage: { inputTokens: 11, outputTokens: 7 } } : {}) } });
}

function runPrompt(id, text) {
  const sessionId = 'fx-session'; // single-session fixture; content is what matters
  const finish = (stopReason) => {
    promptIds.delete(id);
    respond(id, { stopReason });
  };
  promptIds.add(id);

  if (text.includes('please error')) {
    // A PROTOCOL error (like claude-code's "Authentication required" on
    // prompt): the request fails, the process stays alive.
    promptIds.delete(id);
    respondError(id, -32000, 'Authentication required');
    return;
  }

  if (text.includes('ask-permission')) {    const permId = nextId++;
    const toolCallId = `tool-${randomUUID().slice(0, 8)}`;
    send({
      jsonrpc: '2.0',
      id: permId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId, title: 'fixture: echo', kind: 'execute' },
        options: [
          { optionId: 'allow_always', name: 'Allow', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });
    permissionWaiters.set(permId, (outcome) => {
      permissionWaiters.delete(permId);
      const allowed = outcome?.outcome === 'selected' && String(outcome.optionId).startsWith('allow');
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallUpdate: {
              toolCallId,
              title: 'fixture: echo',
              kind: 'execute',
              status: allowed ? 'completed' : 'failed',
            },
          },
        },
      });
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          contentBlock: {
            type: 'text',
            text: allowed ? `permission granted: ${outcome.optionId}` : 'denied',
          },
        },
      });
      finish('end_turn');
    });
    return;
  }

  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_thought_chunk', contentBlock: { type: 'text', text: 'thinking about it' } },
  });
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      contentBlock: { type: 'text', text: `echo: ${text}` },
    },
  });
  update(sessionId, 'usage_update');
  finish('end_turn');
}

function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: 1,
        agentInfo: { name: 'fixture-agent', version: '0.1.0' },
        authMethods: [],
      });
      return;
    case 'session/new':
      respond(id, { sessionId: `fx-${randomUUID().slice(0, 8)}`, cwd: params?.cwd ?? process.cwd() });
      return;
    case 'session/prompt': {
      const prompt = Array.isArray(params?.prompt) ? params.prompt : [];
      const text = prompt.map((b) => (b.type === 'text' ? b.text : `[@${b.name ?? 'x'}]`)).join('');
      runPrompt(id, text);
      return;
    }
    case 'session/cancel':
      for (const pid of [...promptIds]) {
        promptIds.delete(pid);
        respond(pid, { stopReason: 'cancelled' });
      }
      respond(id, {});
      return;
    case 'session/close':
      respond(id, {});
      return;
    default:
      respondError(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
    // A response — to our session/request_permission. The ACP result shape is
    // { outcome: { outcome: 'selected'|'cancelled', optionId? } }.
    const waiter = permissionWaiters.get(msg.id);
    if (waiter) {
      const result = msg.result ?? {};
      waiter(result.outcome ?? { outcome: 'cancelled' });
    }
    return;
  }
  if (msg.method === undefined) return;
  if (msg.method === 'initialized') return; // notification
  if (msg.id === undefined || msg.id === null) return; // other notifications: ignore
  handleRequest(msg);
});

process.stdin.on('end', () => process.exit(0));
