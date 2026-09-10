#!/usr/bin/env node
/**
 * Fixture ACP agent (Phase 8 C5 tests + smoke; 9 W7 adds sessions). Speaks
 * ACP v1 — JSON-RPC 2.0, newline-delimited — over stdio:
 *
 *   initialize → {protocolVersion: 1, agentInfo, agentCapabilities}
 *                (advertises sessionCapabilities list+load+resume+close unless
 *                 FIXTURE_ACP_NO_LOAD=1 → resume only, the dsh shape)
 *   session/new → {sessionId, cwd}
 *   session/list → one canned native session (9 W7)
 *   session/load → REPLAYS one prior turn as session/update notifications
 *                  (user_message_chunk + agent_message_chunk + a completed
 *                  tool_call), then responds {sessionId} (the claude shape)
 *   session/resume → {} with NO replay (the dsh shape)
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
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// 9 W7 leak regression: tests point FIXTURE_PID_FILE here to observe that the
// daemon KILLS this process when establishment fails (stdin-end exit alone is
// NOT the kill path being asserted).
if (process.env.FIXTURE_PID_FILE) {
  try {
    appendFileSync(process.env.FIXTURE_PID_FILE, `${process.pid}\n`);
  } catch {
    /* best effort */
  }
}

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

/** session/update with an envelope `_meta` (Claude toolName rides there). */
function updateMeta(sessionId, sessionUpdate, meta) {
  notify('session/update', {
    sessionId,
    update: sessionUpdate,
    _meta: meta,
  });
}

/**
 * `show-tools` prompt: a full turn exercising the 9 W6 rich cards — a Read
 * (rawOutput body), a Bash (rawInput + output), an Edit (structured diff),
 * markdown + a code fence, then usage → end_turn.
 */
function runToolShowcase(id, sessionId) {
  const finish = () => {
    update(sessionId, 'usage_update');
    respond(id, { stopReason: 'end_turn' });
  };

  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      contentBlock: { type: 'text', text: 'Inspecting the workspace first.\n\n' },
    },
  });

  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 'fx-read-1',
        title: 'src/app.ts',
        kind: 'read',
        status: 'in_progress',
      },
    },
    { claudeCode: { toolName: 'Read' } },
  );
  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call_update',
      toolCallUpdate: {
        toolCallId: 'fx-read-1',
        title: 'src/app.ts',
        kind: 'read',
        status: 'completed',
        rawOutput: [
          '1\timport { main } from "./lib.js";',
          '2',
          '3\t// entry point',
          '4\tawait main();',
          '5',
        ].join('\n'),
      },
    },
    { claudeCode: { toolName: 'Read' } },
  );

  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 'fx-bash-1',
        title: 'npm test',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'npm test', description: 'run the test suite' },
      },
    },
    { claudeCode: { toolName: 'Bash' } },
  );
  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call_update',
      toolCallUpdate: {
        toolCallId: 'fx-bash-1',
        status: 'completed',
        rawOutput: '> harness-nexus@0.1.0 test\n> vitest run\n\n ✓ 99 passed (99)',
      },
    },
    { claudeCode: { toolName: 'Bash' } },
  );

  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 'fx-edit-1',
        title: 'src/app.ts',
        kind: 'edit',
        status: 'in_progress',
      },
    },
    { claudeCode: { toolName: 'Edit' } },
  );
  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call_update',
      toolCallUpdate: {
        toolCallId: 'fx-edit-1',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: 'src/app.ts',
            oldText: '// entry point\nawait main();',
            newText: '// entry point (hardened)\nawait main({ retries: 2 });',
          },
        ],
      },
    },
    { claudeCode: { toolName: 'Edit' } },
  );

  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      contentBlock: {
        type: 'text',
        text: [
          'All green. **Summary**:',
          '',
          '- `Read` found the entry point',
          '- `Bash` ran the suite — 99 passing',
          '- `Edit` hardened the bootstrap',
          '',
          '```ts',
          'await main({ retries: 2 });',
          '```',
        ].join('\n'),
      },
    },
  });
  finish();
}

function runPrompt(id, text, deferred = false) {
  const sessionId = 'fx-session'; // single-session fixture; content is what matters
  const finish = (stopReason) => {
    promptIds.delete(id);
    respond(id, { stopReason });
  };
  promptIds.add(id);

  // Test seam: hold the plain echo turn so a test can append transcript
  // frames DURING generation (the dsh live-tail streaming path).
  const delay = Number(process.env.FIXTURE_DELAY_PROMPT_MS ?? '0');
  if (!deferred && delay > 0) {
    setTimeout(() => runPrompt(id, text, true), delay);
    return;
  }

  if (text.includes('please error')) {
    // A PROTOCOL error (like claude-code's "Authentication required" on
    // prompt): the request fails, the process stays alive.
    promptIds.delete(id);
    respondError(id, -32000, 'Authentication required');
    return;
  }

  if (text.includes('show-tools')) {
    runToolShowcase(id, sessionId);
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
        agentCapabilities: {
          promptCapabilities: { image: false },
          sessionCapabilities: process.env.FIXTURE_ACP_NO_LOAD === '1'
            ? { list: {}, resume: {}, close: {} } // the dsh shape — no replay
            : { list: {}, load: {}, resume: {}, close: {} },
        },
      });
      return;
    case 'session/new':
      respond(id, {
        // FIXTURE_SESSION_ID pins the id so tests can pre-create the dsh
        // transcript directory for the live-tail streaming path.
        sessionId: process.env.FIXTURE_SESSION_ID || `fx-${randomUUID().slice(0, 8)}`,
        cwd: params?.cwd ?? process.cwd(),
      });
      return;
    case 'session/list':
      respond(id, {
        sessions: [
          {
            sessionId: 'fx-native-1',
            // A REAL path — the daemon spawns the resume at this cwd, so a
            // canned path that doesn't exist would fail with ENOENT.
            cwd: '/tmp',
            title: 'fixture: prior turn',
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      return;
    case 'session/load': {
      // The claude/codex shape: replay the prior turn BEFORE responding.
      const sid = params?.sessionId ?? 'fx-native-1';
      if (sid === 'fx-native-fail') {
        // Establishment failure (the dsh pinned-model class) — the daemon
        // must surface the error AND kill this adapter process.
        respondError(id, -32603, 'Internal error: pi-ai provider "harness-nexus" has no configured model "deepseek-chat"');
        return;
      }
      notify('session/update', {
        sessionId: sid,
        update: {
          sessionUpdate: 'user_message_chunk',
          contentBlock: { type: 'text', text: 'what did we conclude?' },
        },
      });
      notify('session/update', {
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          contentBlock: { type: 'text', text: 'We concluded: 42 (replayed).' },
        },
      });
      updateMeta(
        sid,
        {
          sessionUpdate: 'tool_call',
          toolCallUpdate: {
            toolCallId: 'fx-replay-tool',
            title: 'notes.txt',
            kind: 'read',
            status: 'completed',
            rawOutput: '42',
          },
        },
        { claudeCode: { toolName: 'Read' } },
      );
      respond(id, { sessionId: sid });
      return;
    }
    case 'session/resume':
      // The dsh shape: restores the log WITHOUT replaying old updates.
      respond(id, {});
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
