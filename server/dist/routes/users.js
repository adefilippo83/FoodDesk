import { and, eq } from 'drizzle-orm';
import { requireAdmin } from '../auth/acl.js';
import { hashPassword } from '../auth/password.js';
import { users } from '../db/schema.js';
const ROLES = ['admin', 'operator'];
export function userRoutes(db) {
    return async function register(app) {
        // Every route in this plugin is admin-only.
        app.addHook('preHandler', requireAdmin);
        app.get('/api/users', async () => {
            const rows = await db
                .select({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                role: users.role,
                active: users.active,
                createdAt: users.createdAt,
            })
                .from(users);
            return rows;
        });
        app.post('/api/users', async (req, reply) => {
            const body = req.body;
            const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
            const password = typeof body?.password === 'string' ? body.password : '';
            const displayName = typeof body?.displayName === 'string' && body.displayName.trim()
                ? body.displayName.trim()
                : username;
            const role = body?.role;
            if (!username || !password) {
                return reply.code(400).send({ error: 'username_and_password_required' });
            }
            if (password.length < 8) {
                return reply.code(400).send({ error: 'password_too_short', minLength: 8 });
            }
            if (!ROLES.includes(role)) {
                return reply.code(400).send({ error: 'invalid_role', allowed: ROLES });
            }
            const existing = (await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1))[0];
            if (existing)
                return reply.code(409).send({ error: 'username_taken' });
            const inserted = (await db
                .insert(users)
                .values({ username, passwordHash: await hashPassword(password), displayName, role })
                .returning({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                role: users.role,
                active: users.active,
            }))[0];
            return reply.code(201).send(inserted);
        });
        app.patch('/api/users/:id', async (req, reply) => {
            const id = Number(req.params.id);
            const body = req.body;
            const target = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
            if (!target)
                return reply.code(404).send({ error: 'not_found' });
            const patch = {};
            if (typeof body?.displayName === 'string' && body.displayName.trim()) {
                patch.displayName = body.displayName.trim();
            }
            if (typeof body?.password === 'string') {
                if (body.password.length < 8) {
                    return reply.code(400).send({ error: 'password_too_short', minLength: 8 });
                }
                patch.passwordHash = await hashPassword(body.password);
            }
            if (body?.role !== undefined) {
                if (!ROLES.includes(body.role)) {
                    return reply.code(400).send({ error: 'invalid_role', allowed: ROLES });
                }
                patch.role = body.role;
            }
            if (typeof body?.active === 'boolean')
                patch.active = body.active;
            // Guard against an admin locking everyone out of the admin surface.
            const losingAdmin = target.role === 'admin' &&
                ((patch.role !== undefined && patch.role !== 'admin') || patch.active === false);
            if (losingAdmin) {
                const admins = await db
                    .select({ id: users.id })
                    .from(users)
                    .where(and(eq(users.role, 'admin'), eq(users.active, true)));
                if (admins.length <= 1) {
                    return reply.code(409).send({ error: 'last_admin' });
                }
            }
            if (Object.keys(patch).length === 0)
                return reply.code(400).send({ error: 'nothing_to_update' });
            const updated = (await db.update(users).set(patch).where(eq(users.id, id)).returning({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                role: users.role,
                active: users.active,
            }))[0];
            return updated;
        });
    };
}
