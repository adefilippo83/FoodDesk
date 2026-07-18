import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { makeTestApp, makeUser, login } from './helpers.js';
/**
 * The contract this suite defends: an operator can never reach an admin route,
 * regardless of what the UI shows them.
 */
const ADMIN_ROUTES = [
    { method: 'GET', url: '/api/users' },
    {
        method: 'POST',
        url: '/api/users',
        payload: { username: 'sneaky', password: 'password123', role: 'admin' },
    },
    { method: 'PATCH', url: '/api/users/1', payload: { displayName: 'hacked' } },
];
describe('ACL', () => {
    let app;
    let close;
    let adminCookie;
    let operatorCookie;
    before(async () => {
        const t = await makeTestApp();
        app = t.app;
        close = t.close;
        await makeUser(t.db, 'admin', 'admin');
        await makeUser(t.db, 'waiter', 'operator');
        adminCookie = await login(app, 'admin');
        operatorCookie = await login(app, 'waiter');
    });
    after(() => {
        void app.close();
        close();
    });
    for (const route of ADMIN_ROUTES) {
        it(`rejects anonymous ${route.method} ${route.url} with 401`, async () => {
            const res = await app.inject({
                method: route.method,
                url: route.url,
                payload: route.payload,
            });
            assert.equal(res.statusCode, 401);
        });
        it(`rejects operator ${route.method} ${route.url} with 403`, async () => {
            const res = await app.inject({
                method: route.method,
                url: route.url,
                headers: { cookie: operatorCookie },
                payload: route.payload,
            });
            assert.equal(res.statusCode, 403);
            assert.equal(res.json().error, 'forbidden');
        });
        it(`allows admin ${route.method} ${route.url}`, async () => {
            const res = await app.inject({
                method: route.method,
                url: route.url,
                headers: { cookie: adminCookie },
                payload: route.payload,
            });
            assert.ok(res.statusCode < 400, `expected success, got ${res.statusCode}: ${res.body}`);
        });
    }
    it('does not leak a session to a forged cookie', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/api/users',
            headers: { cookie: 'fd_session=totally-made-up-session-id' },
        });
        assert.equal(res.statusCode, 401);
    });
});
describe('auth', () => {
    let app;
    let close;
    before(async () => {
        const t = await makeTestApp();
        app = t.app;
        close = t.close;
        await makeUser(t.db, 'waiter', 'operator');
        await makeUser(t.db, 'fired', 'operator', 'password123', false);
    });
    after(() => {
        void app.close();
        close();
    });
    it('rejects a wrong password', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { username: 'waiter', password: 'wrong' },
        });
        assert.equal(res.statusCode, 401);
    });
    it('rejects an inactive user with the same error as a bad password', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { username: 'fired', password: 'password123' },
        });
        assert.equal(res.statusCode, 401);
        assert.equal(res.json().error, 'invalid_credentials');
    });
    it('returns the current user from /me and clears it on logout', async () => {
        const cookie = await login(app, 'waiter');
        const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
        assert.equal(me.statusCode, 200);
        assert.equal(me.json().role, 'operator');
        const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
        assert.equal(out.statusCode, 200);
        // The session must be dead server-side, not just cleared in the browser.
        const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
        assert.equal(after.statusCode, 401);
    });
});
