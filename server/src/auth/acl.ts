import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Role, User } from '../db/schema.js'

declare module 'fastify' {
  interface FastifyRequest {
    user?: User
  }
}

/**
 * Authorization is enforced here, on the server, for every protected route.
 * The UI hiding admin screens from operators is cosmetic only.
 */

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    return reply.code(401).send({ error: 'authentication_required' })
  }
}

export function requireRole(...allowed: Role[]) {
  return async function roleGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.user) {
      return reply.code(401).send({ error: 'authentication_required' })
    }
    if (!allowed.includes(req.user.role)) {
      req.log.warn(
        { userId: req.user.id, role: req.user.role, path: req.url, method: req.method },
        'acl denied',
      )
      return reply.code(403).send({ error: 'forbidden' })
    }
  }
}

export const requireAdmin = requireRole('admin')
