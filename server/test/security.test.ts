import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { resetLockouts } from '../src/auth/lockout.js'
import { login, makeTestApp, makeUser } from './helpers.js'

describe('security hardening', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string
  let beerId: number

  before(async () => {
    resetLockouts()
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    await makeUser(t.db, 'locky', 'operator')
    await makeUser(t.db, 'marco', 'operator')
    adminCookie = await login(app, 'admin')

    const cat = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { cookie: adminCookie },
      payload: { name: 'Drinks' },
    })
    const beer = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { cookie: adminCookie },
      payload: { name: 'Beer', priceCents: 500, categoryId: cat.json().id },
    })
    beerId = beer.json().id
  })

  after(() => {
    void app.close()
    close()
    resetLockouts()
  })

  // ---- login lockout ----

  it('locks a username+IP pair after 5 failures, even for the right password', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'locky', password: 'wrong-password' },
      })
      assert.equal(res.statusCode, 401, `attempt ${i + 1} should still be 401`)
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'locky', password: 'password123' },
    })
    assert.equal(blocked.statusCode, 429)
    assert.equal(blocked.json().error, 'too_many_attempts')
  })

  it('does not lock out other usernames from the same IP', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'marco', password: 'password123' },
    })
    assert.equal(res.statusCode, 200)
  })

  // ---- origin check ----

  it('rejects a state-changing request with a foreign Origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: {
        cookie: adminCookie,
        origin: 'http://evil.example',
        host: 'localhost:80',
      },
      payload: { customerName: 'X', items: [{ productId: beerId, qty: 1 }] },
    })
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error, 'bad_origin')
  })

  it('accepts the same request from the matching Origin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: {
        cookie: adminCookie,
        origin: 'http://localhost:80',
        host: 'localhost:80',
      },
      payload: { customerName: 'Origin ok', items: [{ productId: beerId, qty: 1 }] },
    })
    assert.equal(res.statusCode, 201)
  })

  it('leaves GETs alone regardless of Origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/menu',
      headers: { cookie: adminCookie, origin: 'http://evil.example' },
    })
    assert.equal(res.statusCode, 200)
  })

  // ---- security headers ----

  it('sets security headers on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN')
    assert.equal(res.headers['referrer-policy'], 'no-referrer')
    assert.match(String(res.headers['content-security-policy']), /default-src 'self'/)
  })

  // ---- body limits ----

  it('rejects an oversized order body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: adminCookie },
      payload: {
        customerName: 'Big',
        note: 'x'.repeat(100 * 1024),
        items: [{ productId: beerId, qty: 1 }],
      },
    })
    assert.equal(res.statusCode, 413)
  })

  it('still accepts a large legitimate settings upload', async () => {
    // A real (tiny) PNG padded conceptually — just verify the route-level
    // limit is above the global one by sending ~100KB of valid PNG data.
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const png = Buffer.concat([pngHeader, Buffer.alloc(100 * 1024)])
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { logoImage: `data:image/png;base64,${png.toString('base64')}` },
    })
    assert.equal(res.statusCode, 200)
    // clean up
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { logoImage: '' },
    })
  })

  // ---- upload magic bytes ----

  it('rejects an upload whose bytes are not really an image', async () => {
    const junk = Buffer.from('hello, not a png at all').toString('base64')
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { logoImage: `data:image/png;base64,${junk}` },
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error, 'invalid_image')
  })

  // ---- session eviction ----

  it('evicts other sessions when a user changes their password', async () => {
    const phoneA = await login(app, 'marco')
    const phoneB = await login(app, 'marco')

    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: phoneA },
      payload: { currentPassword: 'password123', newPassword: 'freshpass456' },
    })
    assert.equal(change.statusCode, 200)

    const a = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: phoneA } })
    const b = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: phoneB } })
    assert.equal(a.statusCode, 200, 'the changing device stays signed in')
    assert.equal(b.statusCode, 401, 'the other device is signed out')
  })

  it('evicts all sessions when an admin resets a password', async () => {
    const phone = await login(app, 'marco', 'freshpass456')
    const target = (await app
      .inject({ method: 'GET', url: '/api/users', headers: { cookie: adminCookie } })
      .then((r) => r.json())) as { id: number; username: string }[]
    const marcoId = target.find((u) => u.username === 'marco')!.id

    await app.inject({
      method: 'PATCH',
      url: `/api/users/${marcoId}`,
      headers: { cookie: adminCookie },
      payload: { password: 'password123' },
    })

    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: phone } })
    assert.equal(after.statusCode, 401)
  })
})
