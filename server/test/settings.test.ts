import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { login, makeTestApp, makeUser } from './helpers.js'

describe('settings: per-document paper sizes and version', () => {
  let app: FastifyInstance
  let close: () => void
  let adminCookie: string

  async function getSettings() {
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: adminCookie },
    })
    assert.equal(res.statusCode, 200)
    return res.json()
  }

  async function putSettings(payload: Record<string, unknown>) {
    return app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload,
    })
  }

  before(async () => {
    const t = await makeTestApp()
    app = t.app
    close = t.close
    await makeUser(t.db, 'admin', 'admin')
    adminCookie = await login(app, 'admin')
  })

  after(() => {
    void app.close()
    close()
  })

  it('reports the running version from package.json (issue #33)', async () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const s = await getSettings()
    assert.equal(s.version, pkg.version)
  })

  it('defaults order and kitchen paper to the shared receipt size', async () => {
    const s = await getSettings()
    assert.equal(s.paperSize, 'roll80')
    assert.equal(s.orderPaperSize, 'roll80')
    assert.equal(s.kitchenPaperSize, 'roll80')
  })

  it('keeps unsaved documents following the legacy shared size', async () => {
    // An install that never touched the new keys must behave as before:
    // changing the receipt size moves every document with it.
    const res = await putSettings({ paperSize: 'a4' })
    assert.equal(res.statusCode, 200)
    const s = res.json()
    assert.equal(s.orderPaperSize, 'a4')
    assert.equal(s.kitchenPaperSize, 'a4')
  })

  it('stores order sheet and kitchen ticket sizes independently (issues #34, #35)', async () => {
    const res = await putSettings({ orderPaperSize: 'a5', kitchenPaperSize: 'roll80' })
    assert.equal(res.statusCode, 200)

    // Once saved on their own, the legacy shared size no longer drags them along.
    await putSettings({ paperSize: 'letter' })
    const s = await getSettings()
    assert.equal(s.paperSize, 'letter')
    assert.equal(s.orderPaperSize, 'a5')
    assert.equal(s.kitchenPaperSize, 'roll80')
  })

  for (const field of ['paperSize', 'orderPaperSize', 'kitchenPaperSize'] as const) {
    it(`rejects an invalid ${field}`, async () => {
      const res = await putSettings({ [field]: 'a3' })
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().error, 'invalid_paper_size')
      assert.equal(res.json().field, field)
    })
  }

  it('ignores the read-only version field on save', async () => {
    const res = await putSettings({ version: '9.9.9', restaurantName: 'Sagra' })
    assert.equal(res.statusCode, 200)
    const s = await getSettings()
    assert.notEqual(s.version, '9.9.9')
    assert.equal(s.restaurantName, 'Sagra')
  })

  for (const kind of ['receipt', 'order', 'kitchen'] as const) {
    it(`previews the ${kind} document with the current settings`, async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/settings/preview.pdf?kind=${kind}`,
        headers: { cookie: adminCookie },
      })
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-type'], 'application/pdf')
      assert.ok(res.rawPayload.subarray(0, 5).toString() === '%PDF-', 'missing PDF magic bytes')
    })
  }
})
