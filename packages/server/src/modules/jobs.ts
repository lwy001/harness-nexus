import type { FastifyInstance } from 'fastify';
import type { Machine } from '@harness-nexus/core';
import { AppError, createMachineJobSchema, deployJobPayloadSchema } from '@harness-nexus/shared';
import { jobView } from '../jobs/service.js';

/**
 * Deploy jobs + harness jobs + agent instances (Phase 8 C4 · Phase 9 W2).
 * docs/design/phase-8-c4.md · phase-9-harness-runtime.md §4.2.
 *
 * All machine-scoped endpoints inherit the machine owner-or-admin guard with
 * 404 existence-hiding. A deploy job is fire-and-forget replayable work: it
 * queues when the daemon is offline and drains on reconnect; the daemon
 * executes it through the unchanged 3.3 pipeline against a deploy bundle
 * fetched with its own machine PAT. A harness job (W2) installs/upgrades/pins
 * the harness runtime — OWNER-ONLY to create (admins may view, not mutate:
 * machine-touching actions match chat's owner-only stance) and gated on the
 * daemon's `harness` capability when online.
 */

/**
 * Targets that have a local-write install adapter in the CLI registry.
 * claude-code is served by the 3.5 marketplace emitter (Claude Code installs
 * the plugin itself) — deploying into it from here is not a path. deepseek
 * (T1) writes skills + a home cordis-patch MCP row like the others.
 */
export const DEPLOYABLE_TARGETS = ['hermes', 'codex', 'deepseek'] as const;

export async function jobsRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  const visibleMachine = async (
    id: string,
    requester: { id: string; role: 'admin' | 'user' },
  ): Promise<Machine> => {
    const machine = await app.uow.machines.findById(id);
    if (!machine || (machine.ownerId !== requester.id && requester.role !== 'admin')) {
      throw new AppError('Machine not found', 404, 'MACHINE_NOT_FOUND');
    }
    return machine;
  };

  // ---- POST /api/machines/:id/jobs — create a deploy or harness job ----
  app.post<{ Params: { id: string } }>('/api/machines/:id/jobs', guard, async (req, reply) => {
    const machine = await visibleMachine(req.params.id, req.user!);
    const input = createMachineJobSchema.parse(req.body);

    if (input.type === 'harness') {
      if (input.action === 'apply-config') {
        // Provider config is managed as a SPEC (upsert + queue), not a bare
        // job body — point the caller at the dedicated surface.
        throw new AppError(
          'Use PUT /api/machines/:id/runtime-config/:target to apply provider config',
          409,
          'USE_RUNTIME_CONFIG_ENDPOINT',
        );
      }
      // Owner-only: admins may view jobs but not run installers on someone
      // else's machine (403 — the machine is already visible to them).
      if (machine.ownerId !== req.user!.id) {
        throw new AppError(
          'Harness jobs are owner-only — only the machine owner may manage its software',
          403,
          'MACHINE_OWNER_ONLY',
        );
      }
      // Soft capability gate (deploy's rule): an ONLINE daemon without the
      // harness executor would settle every job as unsupported — refuse early.
      // An OFFLINE machine may queue; capability is knowable once hello'd.
      if (app.realtime.presence.isOnline(machine.id) && !machine.capabilities.includes('harness')) {
        throw new AppError(
          'Daemon does not advertise the harness capability (upgrade hnx on the machine)',
          409,
          'DAEMON_NO_HARNESS',
        );
      }
      const job = await app.realtime.jobs.createJob({
        machineId: machine.id,
        ownerId: req.user!.id,
        type: 'harness',
        payload: input as unknown as Record<string, unknown>,
      });
      return reply.code(201).send({ job: jobView(job) });
    }

    const deployInput = deployJobPayloadSchema.parse({
      profileId: input.profileId,
      ...(input.directory !== undefined ? { directory: input.directory } : {}),
    });
    const profile = await app.uow.profiles.findById(deployInput.profileId);
    const profileVisible =
      profile &&
      (profile.scope === 'global' ||
        profile.ownerId === req.user!.id ||
        req.user!.role === 'admin');
    if (!profile || !profileVisible) {
      throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
    }
    // Soft capability gate: an online daemon without the 'deploy' capability
    // would silently abandon-cycle (dispatch → ack-timeout → requeue). An
    // OFFLINE machine is allowed to queue — capability is only knowable once
    // the daemon says hello.
    if (app.realtime.presence.isOnline(machine.id) && !machine.capabilities.includes('deploy')) {
      throw new AppError(
        'Daemon does not advertise the deploy capability (upgrade hnx on the machine)',
        409,
        'DAEMON_NO_DEPLOY',
      );
    }
    if (!DEPLOYABLE_TARGETS.includes(profile.target as (typeof DEPLOYABLE_TARGETS)[number])) {
      throw new AppError(
        `Profiles for target '${profile.target}' are deployed via ${
          profile.target === 'claude-code'
            ? 'the Claude Code plugin marketplace (3.5)'
            : 'a path this instance does not serve'
        }, not a remote deploy job`,
        409,
        'TARGET_NOT_DEPLOYABLE',
      );
    }

    const job = await app.realtime.jobs.createJob({
      machineId: machine.id,
      ownerId: req.user!.id,
      type: 'deploy',
      payload: {
        profileId: profile.id,
        ...(deployInput.directory ? { directory: deployInput.directory } : {}),
      },
    });
    return reply.code(201).send({ job: jobView(job) });
  });

  // ---- GET /api/machines/:id/jobs — newest first ----
  app.get<{ Params: { id: string } }>('/api/machines/:id/jobs', guard, async (req) => {
    const machine = await visibleMachine(req.params.id, req.user!);
    const jobs = await app.uow.jobs.listByMachine(machine.id);
    return { jobs: jobs.map(jobView) };
  });

  // ---- POST /api/jobs/:jobId/cancel — queued only ----
  app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/cancel', guard, async (req) => {
    const job = await app.realtime.jobs.cancel(req.params.jobId, req.user!);
    return { job: jobView(job) };
  });

  // ---- GET /api/machines/:id/agents — deployed agent instances ----
  app.get<{ Params: { id: string } }>('/api/machines/:id/agents', guard, async (req) => {
    const machine = await visibleMachine(req.params.id, req.user!);
    const agents = await app.uow.agentInstances.listByMachine(machine.id);
    return { agents };
  });

  // ---- GET /api/agent-instances/:id — the chat session page's header (9 W6) ----
  // Chat itself is owner-ONLY by design, so the lookup is too: a non-owner
  // (admin included) gets the 404 rather than a machine reveal.
  app.get<{ Params: { id: string } }>('/api/agent-instances/:id', guard, async (req) => {
    const agent = await app.uow.agentInstances.findById(req.params.id);
    if (!agent || agent.ownerId !== req.user!.id) {
      throw new AppError('Agent instance not found', 404, 'AGENT_INSTANCE_NOT_FOUND');
    }
    const machine = await app.uow.machines.findById(agent.machineId);
    if (!machine) throw new AppError('Agent instance not found', 404, 'AGENT_INSTANCE_NOT_FOUND');
    return {
      agent,
      machine: {
        id: machine.id,
        name: machine.name,
        online: app.realtime.presence.isOnline(machine.id),
        remoteChatEnabled: machine.remoteChatEnabled,
        baseWorkspace: machine.baseWorkspace,
        capabilities: machine.capabilities,
      },
    };
  });

  // ---- GET /api/agent-instances/:id/sessions — AcSession audit rows (C5) ----
  // Listing is owner-or-admin like every machine-scoped read; CHATTING is
  // owner-only (enforced in the chat service, not here).
  app.get<{ Params: { id: string } }>('/api/agent-instances/:id/sessions', guard, async (req) => {
    const agent = await app.uow.agentInstances.findById(req.params.id);
    if (!agent) throw new AppError('Agent instance not found', 404, 'AGENT_INSTANCE_NOT_FOUND');
    await visibleMachine(agent.machineId, req.user!);
    const sessions = await app.uow.acSessions.listByAgentInstance(agent.id);
    return { agent, sessions };
  });
}
