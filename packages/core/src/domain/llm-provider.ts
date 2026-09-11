/**
 * Phase 9 W10 — a reusable LLM route (cc-switch-style provider catalog).
 * The provider is the ROUTE, never the secret: the API key lives in the
 * encrypted Credential store and is referenced by name, so the W3 apply path
 * (distributable credential → machine-PAT bundle) is reused verbatim.
 * See docs/design/phase-9-w10-llm-providers.md.
 */

/** Finer-grained than the W3 spec flavor: codex is Responses-only, dsh speaks chat. */
export type LlmProviderApi = 'openai-chat' | 'openai-responses' | 'anthropic';

export interface LlmProvider {
  id: string;
  name: string;
  api: LlmProviderApi;
  /** null = the kind's official endpoint (Anthropic / OpenAI proper). */
  baseUrl: string | null;
  /** Handle of the Credential carrying the API key (not an id — like RuntimeConfig). */
  credentialName: string;
  scope: 'global' | 'personal';
  /** null iff scope === 'global'; otherwise the owning user id. */
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}
