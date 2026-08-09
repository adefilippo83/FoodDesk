import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { Order } from '../src/db/schema.js'
import { paypalProvider } from '../src/payments/paypal.js'

/**
 * The PayPal provider against a local mock: OAuth caching, order creation,
 * the APPROVED→capture transition with both benign races, the no-void
 * cancel semantics, and refund via the capture id.
 */

type Captured = { method: string; path: string; auth?: string; body: unknown }

describe('paypal provider (REST against a local mock)', () => {
  let server: Server
  let captured: Captured[] = []
  let tokenRequests = 0
  let rejectBearer: string | null = null
  let respond: (method: string, path: string) => { status: number; body: unknown } = () => ({
    status: 200,
    body: {},
  })

  const order = {
    id: 9,
    dailyNumber: 12,
    customerName: 'Tavolo 4',
    totalCents: 1850,
  } as Order

  const apiCalls = () => captured.filter((c) => !c.path.startsWith('/v1/oauth2'))

  before(async () => {
    server = createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        if (req.url === '/v1/oauth2/token') {
          tokenRequests++
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ access_token: `tok_${tokenRequests}`, expires_in: 32000 }))
          return
        }
        captured.push({
          method: req.method!,
          path: req.url!,
          auth: req.headers.authorization,
          body: data ? JSON.parse(data) : undefined,
        })
        if (rejectBearer && req.headers.authorization === `Bearer ${rejectBearer}`) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        const { status, body } = respond(req.method!, req.url!)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    process.env.PAYPAL_API_BASE = `http://127.0.0.1:${port}`
  })

  after(() => {
    delete process.env.PAYPAL_API_BASE
    server.close()
  })

  beforeEach(() => {
    captured = []
    rejectBearer = null
  })

  it('creates an order with the server-side amount and returns the approve link', async () => {
    const p = paypalProvider('cid', 'csecret')
    respond = () => ({
      status: 201,
      body: {
        id: 'PP-1',
        links: [
          { rel: 'self', href: 'x' },
          { rel: 'approve', href: 'https://paypal.test/approve/PP-1' },
        ],
      },
    })
    const created = await p.createPayment(order, 'http://10.42.0.1/o/tok')
    assert.equal(created.ref, 'PP-1')
    assert.equal(created.redirectUrl, 'https://paypal.test/approve/PP-1')

    const req = apiCalls().at(-1)! as Captured & {
      body: {
        intent: string
        purchase_units: { amount: { value: string; currency_code: string } }[]
        application_context: { user_action: string; return_url: string }
      }
    }
    assert.equal(req.path, '/v2/checkout/orders')
    assert.equal(req.body.intent, 'CAPTURE')
    assert.equal(req.body.purchase_units[0]!.amount.value, '18.50')
    assert.equal(req.body.purchase_units[0]!.amount.currency_code, 'EUR')
    assert.equal(req.body.application_context.return_url, 'http://10.42.0.1/o/tok')
  })

  it('caches the OAuth token across calls and refreshes once on 401', async () => {
    const p = paypalProvider('cid', 'csecret')
    respond = () => ({ status: 200, body: { status: 'CREATED' } })
    const before = tokenRequests
    await p.verifyPayment('PP-1')
    await p.verifyPayment('PP-1')
    assert.equal(tokenRequests, before + 1, 'token must be fetched once and cached')

    // Expire the token server-side: one refresh, then the call succeeds.
    rejectBearer = `tok_${tokenRequests}`
    assert.equal(await p.verifyPayment('PP-1'), 'pending')
    assert.equal(tokenRequests, before + 2)
  })

  it('APPROVED triggers our capture; COMPLETED needs none', async () => {
    const p = paypalProvider('cid', 'csecret')
    respond = (method, path) =>
      path.endsWith('/capture')
        ? { status: 201, body: { status: 'COMPLETED' } }
        : { status: 200, body: { status: 'APPROVED' } }
    assert.equal(await p.verifyPayment('PP-2'), 'paid')
    assert.ok(apiCalls().some((c) => c.path === '/v2/checkout/orders/PP-2/capture'))

    captured = []
    respond = () => ({ status: 200, body: { status: 'COMPLETED' } })
    assert.equal(await p.verifyPayment('PP-2'), 'paid')
    assert.ok(!apiCalls().some((c) => c.path.endsWith('/capture')), 'no second capture')
  })

  it('handles both capture races: already captured and declined funding', async () => {
    const p = paypalProvider('cid', 'csecret')
    respond = (method, path) =>
      path.endsWith('/capture')
        ? { status: 422, body: { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] } }
        : { status: 200, body: { status: 'APPROVED' } }
    assert.equal(await p.verifyPayment('PP-3'), 'paid')

    respond = (method, path) =>
      path.endsWith('/capture')
        ? { status: 422, body: { details: [{ issue: 'INSTRUMENT_DECLINED' }] } }
        : { status: 200, body: { status: 'APPROVED' } }
    assert.equal(await p.verifyPayment('PP-3'), 'pending')
  })

  it('cancel succeeds by never capturing — unless already captured', async () => {
    const p = paypalProvider('cid', 'csecret')
    respond = () => ({ status: 200, body: { status: 'APPROVED' } })
    await p.cancelPayment('PP-4')
    assert.ok(!apiCalls().some((c) => c.path.endsWith('/capture')), 'cancel must not capture')

    respond = () => ({ status: 200, body: { status: 'COMPLETED' } })
    await assert.rejects(() => p.cancelPayment('PP-4'), /already captured/)
  })

  it('refunds through the capture id found on the order', async () => {
    const p = paypalProvider('cid', 'csecret')
    respond = (method, path) =>
      path.includes('/v2/payments/captures/')
        ? { status: 201, body: { status: 'COMPLETED' } }
        : {
            status: 200,
            body: {
              status: 'COMPLETED',
              purchase_units: [{ payments: { captures: [{ id: 'CAP-7' }] } }],
            },
          }
    await p.refund('PP-5')
    assert.equal(apiCalls().at(-1)!.path, '/v2/payments/captures/CAP-7/refund')
  })

  it('maps terminal states and resumes the approval link', async () => {
    const p = paypalProvider('cid', 'csecret')
    respond = () => ({ status: 200, body: { status: 'VOIDED' } })
    assert.equal(await p.verifyPayment('PP-6'), 'failed')
    respond = () => ({ status: 404, body: {} })
    assert.equal(await p.verifyPayment('PP-6'), 'failed')

    respond = () => ({
      status: 200,
      body: { status: 'CREATED', links: [{ rel: 'approve', href: 'https://paypal.test/a' }] },
    })
    assert.equal(await p.resumeUrl('PP-6'), 'https://paypal.test/a')
    respond = () => ({ status: 200, body: { status: 'CREATED', links: [] } })
    assert.equal(await p.resumeUrl('PP-6'), null)
  })
})
