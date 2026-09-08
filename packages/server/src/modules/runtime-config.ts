import type { FastifyInstance } from 'fastify';
import type { Machine, RuntimeConfig } from '@harness-nexus/core';
import {
  AppError,
  runtimeConfigSpecSchema,
  runtimeSpecUnsupportedReason,
  runtimeTargetSchema,
  type RuntimeConfigSpec,
  type RuntimeConfigView,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { jobView } from '../jobs/service.js';

/**
 * Runtime provider-config routes (Phase 9 W3).
 * docs/design/phase-9-harness-runtime.md §4.3/§6.
 *
 * One spec per (machine, target). GET is owner-or-admin (404 existence-hiding,
 * like every machine-scoped read); PUT is OWNER-ONLY (admins may view, not
 * mutate — machine-touching actions match harness jobs' and chat's stance) and
 * queues an `apply-config` harness job. The spec references a credential by
 * name; the referenced credential must be distributable (the plaintext leaves
 * the server inside the daemon's machine-PAT bundle) — the same gate the
 * dial-site model applies. The secret itself NEVER appears in any response
 * here; the daemon fetches `{spec, secret}` from `/api/client/runtime-config`.
 */
export async function runtimeConfigRoutes(app: FastifyInstance): Promise<void> {
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

  const toView = (row: RuntimeConfig): RuntimeConfigView => ({
    machineId: row.machineId,
    target: row.target,
    providerLabel: row.spec.providerLabel,
    ...(row.spec.baseUrl !== null ? { baseUrl: row.spec.baseUrl } : {}),
    api: row.spec.api,
    model: row.spec.model,
    credentialName: row.spec.credentialName,
    ...(row.spec.extra !== null ? { extra: row.spec.extra } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  // ---- GET /api/machines/:id/runtime-config/:target — echo the spec (never a secret) ----
  app.get<{ Params: { id: string; target: string } }>(
    '/api/machines/:id/runtime-config/:target',
    guard,
    async (req) => {
      const machine = await visibleMachine(req.params.id, req.user!);
      const parsedTarget = runtimeTargetSchema.safeParse(req.params.target);
      if (!parsedTarget.success) {
        throw new AppError(
          `Target '${req.params.target}' is not runtime-managed`,
          400,
          'RUNTIME_TARGET_INVALID',
        );
      }
      const row = await app.uow.runtimeConfigs.findByMachineAndTarget(
        machine.id,
        parsedTarget.data,
      );
      if (!row) {
        throw new AppError('No runtime config for this target', 404, 'RUNTIME_CONFIG_NOT_FOUND');
      }
      return { config: toView(row) };
    },
  );

  // ---- PUT /api/machines/:id/runtime-config/:target — upsert + queue apply-config ----
  app.put<{ Params: { id: string; target: string } }>(
    '/api/machines/:id/runtime-config/:target',
    guard,
    async (req, reply) => {
      const machine = await visibleMachine(req.params.id, req.user!);
      const parsedTarget = runtimeTargetSchema.safeParse(req.params.target);
      if (!parsedTarget.success) {
        throw new AppError(
          `Target '${req.params.target}' is not runtime-managed`,
          400,
          'RUNTIME_TARGET_INVALID',
        );
      }
      const target = parsedTarget.data;

      // Owner-only: writing a provider route (with its API key) onto someone
      // else's machine is a machine-touching mutation (403 — visible machine).
      if (machine.ownerId !== req.user!.id) {
        throw new AppError(
          'Runtime config is owner-only — only the machine owner may manage its provider route',
          403,
          'MACHINE_OWNER_ONLY',
        );
      }

      const spec: RuntimeConfigSpec = runtimeConfigSpecSchema.parse(req.body);
      const unsupported = runtimeSpecUnsupportedReason(target, spec);
      if (unsupported !== null) {
        throw new AppError(unsupported, 409, 'RUNTIME_CONFIG_UNSUPPORTED');
      }

      // The credential gate (dial-site rules): the plaintext must be allowed to
      // leave the server, and a personal credential of another user does not
      // exist as far as this caller is concerned.
      const cred = await app.uow.credentials.findByName(spec.credentialName);
      if (!cred || (cred.scope === 'personal' && cred.ownerId !== req.user!.id)) {
        throw new AppError(
          `Credential "${spec.credentialName}" not found`,
          404,
          'CREDENTIAL_NOT_FOUND',
        );
      }
      if (!cred.distributable) {
        throw new AppError(
          `Credential "${spec.credentialName}" is not distributable — a runtime config's key is applied on the machine (opt in via the credential's distributable flag)`,
          409,
          'CREDENTIAL_NOT_DISTRIBUTABLE',
        );
      }

      // Soft capability gate (harness jobs' rule): an online daemon without the
      // W3 config executor would settle the job as unsupported — refuse early.
      // An offline machine may queue.
      if (
        app.realtime.presence.isOnline(machine.id) &&
        !machine.capabilities.includes('runtime-config')
      ) {
        throw new AppError(
          'Daemon does not advertise the runtime-config capability (upgrade hnx on the machine)',
          409,
          'DAEMON_NO_RUNTIME_CONFIG',
        );
      }

      const existing = await app.uow.runtimeConfigs.findByMachineAndTarget(machine.id, target);
      const now = new Date().toISOString();
      const row: RuntimeConfig = {
        id: existing?.id ?? generateId(),
        machineId: machine.id,
        ownerId: machine.ownerId,
        target,
        spec: {
          providerLabel: spec.providerLabel,
          baseUrl: spec.baseUrl ?? null,
          api: spec.api,
          model: spec.model,
          credentialName: spec.credentialName,
          extra: spec.extra ?? null,
        },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await app.uow.runtimeConfigs.save(row);

      const job = await app.realtime.jobs.createJob({
        machineId: machine.id,
        ownerId: req.user!.id,
        type: 'harness',
        payload: { type: 'harness', action: 'apply-config', target },
      });
      return reply.code(existing ? 200 : 201).send({ config: toView(row), job: jobView(job) });
    },
  );
}
