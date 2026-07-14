export { createStorage } from './factory.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** UnitOfWork attached in buildApp; available everywhere via app.uow. */
    uow: import('@agent-nexus/core').UnitOfWork;
  }
}
