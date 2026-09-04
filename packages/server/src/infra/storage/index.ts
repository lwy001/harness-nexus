export { createStorage } from './factory.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** UnitOfWork attached in buildApp; available everywhere via app.uow. */
    uow: import('@harness-nexus/core').UnitOfWork;
    /** Key material for AES-256-GCM credential encryption. See config.ts. */
    credentialEncryptionKey: string;
    /** PUBLIC_BASE_URL — absolute origin for emitted marketplace URLs. */
    publicBaseUrl: string;
  }
}
