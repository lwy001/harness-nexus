import type { FastifyInstance } from 'fastify';
import type { Machine } from '@harness-nexus/core';
import { AppError, deployJobPayloadSchema } from '@harness-nexus/shared';
import { jobView } from '../jobs/service.js';

/**
 * Deploy jobs + agent instances (Phase 8 C4). docs/design/phase-8-c4.md.
 *
 * All machine-scoped endpoints inherit the machine owner-or-admin guard with
 * 404 existence-hiding. A deploy job is fire-and-forget replayable work: it
 * queues when the daemon is offline and drains on reconnect; the daemon
 * executes it through the unchanged 3.3 pipeline against a deploy bundle
 * fetched with its own machine PAT.
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

  // ---- POST /api/machines/:id/jobs — create a deploy job ----
  app.post<{ Params: { id: string } }>('/api/machines/:id/jobs', guard, async (req, reply) => {
    const machine = await visibleMachine(req.params.id, req.user!);
    const input = deployJobPayloadSchema.parse(req.body);

    const profile = await app.uow.profiles.findById(input.profileId);
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
        ...(input.directory ? { directory: input.directory } : {}),
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
