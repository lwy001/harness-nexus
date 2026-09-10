/**
 * Repository ports — the contracts storage drivers implement.
 *
 * The core package defines ONLY these interfaces. Concrete implementations
 * (SQLite default, in-memory for tests, a future Postgres adapter) live in
 * `@harness-nexus/server` under `src/infra/storage/*`. Nothing in `core` may
 * import a concrete driver.
 */

import type {
  Credential,
  AgentInstance,
  Job,
  Machine,
  MachineInventorySnapshot,
  McpServer,
  PersonalAccessToken,
  Profile,
  Resource,
  RuntimeConfig,
  SystemSettings,
  User,
} from '../domain/index.js';

export interface ResourceRepository {
  findById(id: string): Promise<Resource | null>;
  findByKey(key: string, scope: 'global' | 'personal', ownerId?: string): Promise<Resource | null>;
  list(filter?: ResourceListFilter): Promise<Resource[]>;
  save(resource: Resource): Promise<Resource>;
  delete(id: string): Promise<void>;
}

export interface ResourceListFilter {
  kind?: Resource['kind'];
  scope?: 'global' | 'personal';
  ownerId?: string;
  target?: Resource['targets'][number];
}

export interface ProfileRepository {
  findById(id: string): Promise<Profile | null>;
  findByName(name: string, scope: 'global' | 'personal', ownerId?: string): Promise<Profile | null>;
  list(filter?: { scope?: 'global' | 'personal'; ownerId?: string }): Promise<Profile[]>;
  save(profile: Profile): Promise<Profile>;
  delete(id: string): Promise<void>;
}

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  list(): Promise<User[]>;
  /** Total user count — used to detect the bootstrap (first) registration. */
  count(): Promise<number>;
  /** Count users with a given role — used for last-admin protection. */
  countByRole(role: User['role']): Promise<number>;
  save(user: User): Promise<User>;
  delete(id: string): Promise<void>;
}

export interface PersonalAccessTokenRepository {
  findById(id: string): Promise<PersonalAccessToken | null>;
  findByTokenHash(tokenHash: string): Promise<PersonalAccessToken | null>;
  listByUser(userId: string): Promise<PersonalAccessToken[]>;
  save(token: PersonalAccessToken): Promise<PersonalAccessToken>;
  touchLastUsed(id: string, at: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface SystemSettingsRepository {
  /** Always returns a value; drivers seed defaults on first access. */
  get(): Promise<SystemSettings>;
  save(settings: SystemSettings): Promise<SystemSettings>;
}

export interface McpServerRepository {
  findById(id: string): Promise<McpServer | null>;
  list(filter?: {
    scope?: 'global' | 'personal';
    ownerId?: string;
    dialSite?: McpServer['dialSite'];
  }): Promise<McpServer[]>;
  save(server: McpServer): Promise<McpServer>;
  delete(id: string): Promise<void>;
}

export interface CredentialRepository {
  findById(id: string): Promise<Credential | null>;
  /** Find by name (used to resolve `${cred:NAME}` placeholders). Names are not unique across scopes; returns the first match. */
  findByName(name: string): Promise<Credential | null>;
  list(filter?: { scope?: 'global' | 'personal'; ownerId?: string }): Promise<Credential[]>;
  save(credential: Credential): Promise<Credential>;
  delete(id: string): Promise<void>;
}

export interface MachineRepository {
  findById(id: string): Promise<Machine | null>;
  /** Resolve a machine from its enrollment PAT — used by the /ctl auth middleware. */
  findByEnrollmentPatId(patId: string): Promise<Machine | null>;
  list(filter?: { ownerId?: string }): Promise<Machine[]>;
  save(machine: Machine): Promise<Machine>;
  delete(id: string): Promise<void>;
}

/**
 * Aggregate of all repositories. A storage driver provides one of these; the
 * server composes it into its modules via dependency injection.
 */
export interface InventoryRepository {
  findLatest(
    machineId: string,
    target: MachineInventorySnapshot['target'],
  ): Promise<MachineInventorySnapshot | null>;
  list(machineId: string): Promise<MachineInventorySnapshot[]>;
  /** Upsert — exactly one row per (machine, target); the latest snapshot wins. */
  save(snapshot: MachineInventorySnapshot): Promise<MachineInventorySnapshot>;
  deleteByMachine(machineId: string): Promise<void>;
}

export interface JobRepository {
  findById(id: string): Promise<Job | null>;
  listByMachine(machineId: string): Promise<Job[]>;
  /** Non-terminal jobs (queued | dispatched | running) — recovery input. */
  listRecoverable(): Promise<Job[]>;
  save(job: Job): Promise<Job>;
  deleteByMachine(machineId: string): Promise<void>;
}

export interface AgentInstanceRepository {
  findById(id: string): Promise<AgentInstance | null>;
  listByMachine(machineId: string): Promise<AgentInstance[]>;
  /** One instance per (machine, profile) — re-deploy upserts. */
  findByMachineAndProfile(machineId: string, profileId: string): Promise<AgentInstance | null>;
  /** The `source: 'detected'` instance for (machine, target) — W1 auto-registration. */
  findByMachineAndTarget(
    machineId: string,
    target: AgentInstance['target'],
  ): Promise<AgentInstance | null>;
  save(instance: AgentInstance): Promise<AgentInstance>;
  delete(id: string): Promise<void>;
  deleteByMachine(machineId: string): Promise<void>;
}

export interface RuntimeConfigRepository {
  /** Exactly one config per (machine, target) — the latest spec wins. */
  findByMachineAndTarget(
    machineId: string,
    target: RuntimeConfig['target'],
  ): Promise<RuntimeConfig | null>;
  /** Upsert by id — (machine, target) identity resolution belongs to the caller. */
  save(config: RuntimeConfig): Promise<RuntimeConfig>;
  /** Machine deletion cascade. */
  deleteByMachine(machineId: string): Promise<void>;
}

export interface UnitOfWork {
  resources: ResourceRepository;
  profiles: ProfileRepository;
  users: UserRepository;
  tokens: PersonalAccessTokenRepository;
  settings: SystemSettingsRepository;
  mcpServers: McpServerRepository;
  credentials: CredentialRepository;
  machines: MachineRepository;
  inventories: InventoryRepository;
  jobs: JobRepository;
  agentInstances: AgentInstanceRepository;
  runtimeConfigs: RuntimeConfigRepository;
}
