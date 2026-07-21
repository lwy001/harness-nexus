import { Link } from 'react-router-dom';
import { ServerIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Dashboard signature: a mesh topology of configured upstreams converging on
 * the Harness Nexus node.
 *
 * Each node's dot reflects its real connection state from the live registry
 * (Phase 2.2): `connected` shows the live `--ok` accent, `error`/`connecting`
 * show warn, and `disconnected`/unknown show muted. The legend documents the
 * states so the diagram never lies.
 *
 * Nodes are laid out on the left half of an SVG, fanning into a central hub on
 * the right. Up to 6 named upstreams are drawn directly; beyond that, the
 * overflow is summarized so the diagram never lies by omission.
 */

import type { McpServerStatus } from '@harness-nexus/sdk';

type Upstream = { id: string; name: string };

/** Map a live status to a Dot variant for rendering. */
function dotVariantFor(
  id: string,
  statuses: McpServerStatus[] | undefined,
): 'configured' | 'pending' | 'online' | 'warn' {
  if (!statuses) return 'configured';
  const s = statuses.find((x) => x.id === id);
  if (!s) return 'configured';
  if (s.status === 'connected') return 'online';
  if (s.status === 'connecting') return 'pending';
  if (s.status === 'error') return 'warn';
  return 'configured';
}

const MAX_NAMED = 6;
// Geometric constants hoisted out of render (static across renders).
const W = 640;
const H = 280;
const HUB_X = 470;
const HUB_Y = H / 2;

export function MeshTopology({
  servers,
  loading,
  statuses,
}: {
  servers: Upstream[];
  loading: boolean;
  statuses?: McpServerStatus[];
}) {
  const shown = servers.slice(0, MAX_NAMED);
  const overflow = Math.max(0, servers.length - MAX_NAMED);
  const hasLive = !!statuses;

  if (loading) {
    return (
      <div
        className="border-muted-foreground/20 bg-muted/30 flex h-[280px] items-center justify-center rounded-xl border border-dashed"
        role="status"
        aria-live="polite"
      >
        <span className="text-muted-foreground text-sm">Loading your mesh…</span>
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div className="border-muted-foreground/20 bg-muted/30 flex h-[280px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-center">
        <ServerIcon className="text-muted-foreground size-6" />
        <div>
          <p className="text-foreground text-sm font-medium">No upstream servers yet</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Add an MCP server to start shaping your mesh.
          </p>
        </div>
        <Button asChild size="sm" className="mt-1">
          <Link to="/mcp-servers">
            <PlusIcon className="size-4" /> Add connection
          </Link>
        </Button>
      </div>
    );
  }

  const count = shown.length;
  // Spread nodes evenly across the vertical span, inset from the edges.
  const top = 36;
  const bottom = H - 36;
  const span = count > 1 ? (bottom - top) / (count - 1) : 0;

  return (
    <div className="border-border bg-card overflow-hidden rounded-xl border">
      <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-sm font-medium">Your mesh</span>
          <span className="text-muted-foreground text-xs nums">
            {servers.length} upstream{servers.length === 1 ? '' : 's'}
          </span>
        </div>
        {/* Legend — documents the live connection states. */}
        <div className="flex items-center gap-3 text-xs">
          {hasLive ? (
            <>
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Dot variant="online" /> connected
              </span>
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Dot variant="warn" /> error
              </span>
            </>
          ) : (
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Dot variant="configured" /> configured
            </span>
          )}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[238px] w-full"
        role="img"
        aria-label={`Mesh of ${servers.length} configured upstream MCP servers converging on Harness Nexus.`}
      >
        {/* signal lines: upstreams -> nexus */}
        <g stroke="currentColor" strokeWidth="1.5" className="text-signal/45">
          {shown.map((s, i) => {
            const y = count === 1 ? HUB_Y : top + i * span;
            return <line key={`l-${s.id}`} x1={70} y1={y} x2={HUB_X - 14} y2={HUB_Y} />;
          })}
        </g>

        {/* upstream nodes */}
        {shown.map((s, i) => {
          const y = count === 1 ? HUB_Y : top + i * span;
          const variant = dotVariantFor(s.id, statuses);
          return (
            <g key={s.id}>
              <circle cx={70} cy={y} r={5} className={nodeFill(variant)} />
              <text
                x={86}
                y={y + 1}
                className="fill-foreground"
                fontSize="13"
                fontFamily="var(--font-mono)"
                dominantBaseline="middle"
              >
                {truncate(s.name, 22)}
              </text>
            </g>
          );
        })}

        {overflow > 0 && (
          <text
            x={86}
            y={bottom + 22}
            className="fill-muted-foreground"
            fontSize="12"
            fontFamily="var(--font-mono)"
          >
            +{overflow} more
          </text>
        )}

        {/* re-exposed fan-out (the one aggregated connection) */}
        <g stroke="currentColor" strokeWidth="1.5" className="text-signal/45">
          <line x1={HUB_X + 14} y1={HUB_Y} x2={W - 50} y2={HUB_Y} />
        </g>

        {/* the nexus node */}
        <circle cx={HUB_X} cy={HUB_Y} r={14} className="fill-signal" />
        <circle cx={HUB_X} cy={HUB_Y} r={14} fill="none" className="stroke-card" strokeWidth={1} />
        <text
          x={HUB_X}
          y={HUB_Y + 34}
          className="fill-foreground"
          fontSize="12"
          fontWeight={600}
          textAnchor="middle"
        >
          Harness Nexus
        </text>

        {/* downstream consumer dot */}
        <circle cx={W - 50} cy={HUB_Y} r={5} className="fill-muted-foreground/70" />
        <text
          x={W - 50}
          y={HUB_Y - 16}
          className="fill-muted-foreground"
          fontSize="11"
          textAnchor="middle"
        >
          tools
        </text>
      </svg>
    </div>
  );
}

/**
 * Status dot for the legend. `configured`/`pending` are muted; `online` carries
 * the live `--ok` accent; `warn` signals a connection error.
 */
function Dot({ variant }: { variant: 'configured' | 'pending' | 'online' | 'warn' }) {
  const cls = {
    configured: 'bg-muted-foreground/70',
    pending: 'bg-muted-foreground/30',
    online: 'bg-ok',
    warn: 'bg-warn',
  }[variant];
  return <span className={`inline-block size-2 rounded-full ${cls}`} aria-hidden="true" />;
}

/** SVG fill class for an upstream node circle, matching the Dot semantics. */
function nodeFill(variant: 'configured' | 'pending' | 'online' | 'warn'): string {
  return {
    configured: 'fill-muted-foreground/70',
    pending: 'fill-muted-foreground/40',
    online: 'fill-ok',
    warn: 'fill-warn',
  }[variant];
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
