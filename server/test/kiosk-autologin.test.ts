import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { makeTestApp, makeUser } from './helpers.js'

describe('kiosk auto-login', () => {
  let app: FastifyInstance
  let close: () => void

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'cucina', 'kitchen')
    await makeUser(t.db, 'mario', 'operator')
    await makeUser(t.db, 'spenta', 'kitchen', 'password123', false)
  })

  after(() => {
    void app.close()
    close()
  })

  afterEach(() => {
    delete process.env.KIOSK_AUTOLOGIN_USER
  })

  const kiosk = (opts: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method: 'GET',
      url: '/api/auth/kiosk',
      remoteAddress: opts.remoteAddress ?? '127.0.0.1',
      headers: opts.headers,
    })

  it('does not exist unless explicitly enabled', async () => {
    const res = await kiosk()
    assert.equal(res.statusCode, 404)
  })

  it('logs the kiosk in from loopback and lands on the kitchen display', async () => {
    process.env.KIOSK_AUTOLOGIN_USER = 'cucina'
    const res = await kiosk()
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/kitchen')

    const cookie = res.cookies.find((c) => c.name === 'fd_session')
    assert.ok(cookie, 'no session cookie set')
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `fd_session=${cookie!.value}` },
    })
    assert.equal(me.statusCode, 200)
    assert.equal(me.json().username, 'cucina')
    assert.equal(me.json().role, 'kitchen')
  })

  it('refuses any non-loopback client', async () => {
    process.env.KIOSK_AUTOLOGIN_USER = 'cucina'
    const res = await kiosk({ remoteAddress: '10.42.0.23' })
    assert.equal(res.statusCode, 403)
    assert.equal(res.cookies.length, 0)
  })

  it('refuses proxied requests even when the proxy is loopback', async () => {
    // Anything that came through nginx carries X-Forwarded-For; the kiosk
    // browser talks to the app port directly and never does.
    process.env.KIOSK_AUTOLOGIN_USER = 'cucina'
    const res = await kiosk({ headers: { 'x-forwarded-for': '127.0.0.1' } })
    assert.equal(res.statusCode, 403)
  })

  it('refuses a configured user that is not kitchen-role', async () => {
    process.env.KIOSK_AUTOLOGIN_USER = 'mario'
    const res = await kiosk()
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error, 'kiosk_user_invalid')
  })

  it('refuses a disabled kitchen account', async () => {
    process.env.KIOSK_AUTOLOGIN_USER = 'spenta'
    const res = await kiosk()
    assert.equal(res.statusCode, 403)
  })

  it('refuses an unknown configured username', async () => {
    process.env.KIOSK_AUTOLOGIN_USER = 'ghost'
    const res = await kiosk()
    assert.equal(res.statusCode, 403)
  })
})
