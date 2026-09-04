import { describe, expect, it } from 'vitest';
import {
  diffInventory,
  importMachineInventorySchema,
  inventoryItemSchema,
  inventoryReportEventSchema,
  inventorySnapshotSchema,
  inventoryPayloadEventSchema,
  type InventoryItem,
} from '../src/index.js';

const item = (over: Partial<InventoryItem> & Pick<InventoryItem, 'kind' | 'name'>): InventoryItem =>
  inventoryItemSchema.parse({
    origin: 'local',
    path: `~/${over.name}`,
    importable: true,
    ...over,
  });

describe('inventorySnapshotSchema', () => {
  it('accepts a well-formed snapshot and defaults nothing silently', () => {
    const parsed = inventorySnapshotSchema.parse({
      target: 'claude-code',
      scannedAt: new Date().toISOString(),
      agents: [
        {
          name: '~/.claude',
          directory: '/home/me/.claude',
          profileApplied: null,
          items: [
            {
              kind: 'skill',
              name: 'docx',
              origin: 'platform',
              path: 'skills/docx',
              importable: true,
              summary: 'Work with Word documents',
              meta: { multi: true },
            },
          ],
        },
      ],
    });
    expect(parsed.agents[0]!.items[0]!.meta?.multi).toBe(true);
  });

  it('rejects an empty agents array and non-datetime scannedAt', () => {
    const base = { target: 'codex', scannedAt: new Date().toISOString() };
    expect(inventorySnapshotSchema.safeParse({ ...base, agents: [] }).success).toBe(false);
    expect(
      inventorySnapshotSchema.safeParse({
        target: 'codex',
        scannedAt: 'yesterday',
        agents: [
          { name: '~/.codex', directory: '/home/me/.codex', profileApplied: false, items: [] },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('inventory realtime event schemas', () => {
  it('report event validates the nested snapshot', () => {
    const ok = inventoryReportEventSchema.safeParse({
      requestId: 'req-1',
      snapshot: {
        target: 'hermes',
        scannedAt: new Date().toISOString(),
        agents: [
          { name: '~/.hermes', directory: '/home/me/.hermes', profileApplied: false, items: [] },
        ],
      },
    });
    expect(ok.success).toBe(true);
    expect(inventoryReportEventSchema.safeParse({ snapshot: { target: 'nope' } }).success).toBe(
      false,
    );
  });

  it('payload event carries redacted mcp artifacts', () => {
    const ok = inventoryPayloadEventSchema.safeParse({
      requestId: 'req-2',
      items: [
        {
          kind: 'mcp',
          name: 'github',
          ok: true,
          artifact: {
            kind: 'mcp',
            transport: {
              type: 'stdio',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
              env: { GITHUB_TOKEN: '${cred:GITHUB_TOKEN}' },
            },
          },
        },
        { kind: 'command', name: 'deploy', ok: false, error: 'too-large' },
      ],
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.items[0].artifact?.kind).toBe('mcp');
    }
  });
});

describe('importMachineInventorySchema', () => {
  it('requires at least one item and a profile name', () => {
    expect(
      importMachineInventorySchema.safeParse({ target: 'codex', profileName: '', items: [] })
        .success,
    ).toBe(false);
    expect(
      importMachineInventorySchema.safeParse({
        target: 'codex',
        profileName: 'My import',
        items: [{ kind: 'skill', name: 'docx' }],
      }).success,
    ).toBe(true);
  });
});

describe('diffInventory', () => {
  it('matches by (kind, name) and splits missing vs candidates', () => {
    const items = [
      item({ kind: 'skill', name: 'docx', origin: 'platform' }),
      item({ kind: 'command', name: 'deploy' }),
      item({ kind: 'skill', name: 'scratch-notes' }),
      item({ kind: 'sub_agent', name: 'reviewer', origin: 'platform' }),
    ];
    const diff = diffInventory(
      [
        { kind: 'skill', name: 'docx' }, // on machine, platform-written
        { kind: 'command', name: 'deploy' }, // on machine, local origin — matched, not a candidate
        { kind: 'skill', name: 'pdf' }, // profile entry with no artifact
      ],
      items,
    );
    expect(diff.upToDate).toEqual([
      { kind: 'skill', name: 'docx', origin: 'platform' },
      { kind: 'command', name: 'deploy', origin: 'local' },
    ]);
    expect(diff.missingOnMachine).toEqual([{ kind: 'skill', name: 'pdf' }]);
    expect(diff.notInProfile.map((i) => i.name)).toEqual(['scratch-notes']);
    expect(diff.summary).toEqual({ profileEntries: 3, applied: 2, missing: 1, candidates: 1 });
  });

  it('treats the MCP arm coarsely — one platform shim entry applies every mcp entry', () => {
    const withShim = [item({ kind: 'mcp', name: 'harness-nexus-my-profile', origin: 'platform' })];
    const entries = [
      { kind: 'mcp', name: 'github' },
      { kind: 'mcp', name: 'postgres' },
    ];
    expect(diffInventory(entries, withShim).missingOnMachine).toEqual([]);
    expect(diffInventory(entries, withShim).summary.applied).toBe(2);
    expect(diffInventory(entries, []).missingOnMachine.map((e) => e.name)).toEqual([
      'github',
      'postgres',
    ]);
  });

  it('never lists local mcp items or foreign platform items as candidates', () => {
    const items = [
      item({ kind: 'mcp', name: 'my-local-server' }),
      item({ kind: 'skill', name: 'other-profile-skill', origin: 'platform' }),
    ];
    const diff = diffInventory([{ kind: 'skill', name: 'docx' }], items);
    expect(diff.notInProfile).toEqual([]);
    expect(diff.missingOnMachine).toEqual([{ kind: 'skill', name: 'docx' }]);
  });
});
