/**
 * @agent-nexus/sdk — thin HTTP client for the AgentNexus REST API.
 *
 * Used by the web SPA, the install CLI (when it talks to a running server),
 * and external scripts. Auth is via PAT (`Authorization: Bearer anpat_…`).
 *
 * Implementation is TODO; this file fixes the surface area.
 */
import type { Profile, Resource, User } from '@agent-nexus/core';

export interface SdkOptions {
  baseUrl: string;
  /** Raw PAT or session token, sent as `Authorization: Bearer <token>`. */
  token?: string;
  fetch?: typeof fetch;
}

export class AgentNexusClient {
  constructor(private readonly opts: SdkOptions) {}

  // ---- users ----
  async getCurrentUser(): Promise<User> {
    throw notImplemented('getCurrentUser');
  }

  // ---- resources ----
  async listResources(): Promise<Resource[]> {
    throw notImplemented('listResources');
  }

  // ---- profiles ----
  async listProfiles(): Promise<Profile[]> {
    throw notImplemented('listProfiles');
  }

  async installProfiles(_profileIds: string[], _target: string): Promise<void> {
    throw notImplemented('installProfiles');
  }
}

function notImplemented(name: string): Error {
  return new Error(`AgentNexusClient.${name}() is not implemented yet`);
}
