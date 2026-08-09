import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import type { Order } from '../src/db/schema.js'
import { stripeProvider } from '../src/payments/stripe.js'

/**
 * The Stripe provider speaks plain REST — point STRIPE_API_BASE at a local
 * mock and assert both what it sends and how it maps what comes back.
 */

type Captured = { method: string; path: string; auth?: string; body: URLSearchParams }

describe('stripe provider (REST against a local mock)', () => {
  let server: Server
  const captured: Captured[] = []
  let respond: (path: string) => { status: number; body: unknown } = () => ({
    status: 200,
    body: {},
  })

  const order = {
    id: 42,
    dailyNumber: 7,
    customerName: 'Tavolo 3',
    totalCents: 2350,
  } as Order

  before(async () => {
    server = createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        captured.push({
          method: req.method!,
          path: req.url!,
          auth: req.headers.authorization,
          body: new URLSearchParams(data),
        })
        const { status, body } = respond(req.url!)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    process.env.STRIPE_API_BASE = `http://127.0.0.1:${port}`
  })

  after(() => {
    delete process.env.STRIPE_API_BASE
    server.close()
  })

  it('creates a checkout session with the server-side amount', async () => {
    respond = () => ({
      status: 200,
      body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/pay/cs_test_1' },
    })
    const p = stripeProvider('sk_test_abc')
    const created = await p.createPayment(order, 'http://10.42.0.1/o/tok')
    assert.equal(created.ref, 'cs_test_1')
    assert.equal(created.redirectUrl, 'https://checkout.stripe.com/pay/cs_test_1')

    const req = captured.at(-1)!
    assert.equal(req.method, 'POST')
    assert.equal(req.path, '/v1/checkout/sessions')
    assert.equal(req.auth, 'Bearer sk_test_abc')
    assert.equal(req.body.get('mode'), 'payment')
    assert.equal(req.body.get('line_items[0][price_data][unit_amount]'), '2350')
    assert.equal(req.body.get('line_items[0][price_data][currency]'), 'eur')
    assert.equal(req.body.get('success_url'), 'http://10.42.0.1/o/tok')
    assert.equal(req.body.get('metadata[fooddesk_order]'), '42')
  })

  it('maps session states to paid / pending / failed', async () => {
    const p = stripeProvider('sk_test_abc')
    respond = () => ({ status: 200, body: { payment_status: 'paid', status: 'complete' } })
    assert.equal(await p.verifyPayment('cs_1'), 'paid')
    respond = () => ({ status: 200, body: { payment_status: 'unpaid', status: 'open' } })
    assert.equal(await p.verifyPayment('cs_1'), 'pending')
    respond = () => ({ status: 200, body: { payment_status: 'unpaid', status: 'expired' } })
    assert.equal(await p.verifyPayment('cs_1'), 'failed')
  })

  it('cancel expires the session and surfaces provider refusal', async () => {
    const p = stripeProvider('sk_test_abc')
    respond = () => ({ status: 200, body: {} })
    await p.cancelPayment('cs_2')
    assert.equal(captured.at(-1)!.path, '/v1/checkout/sessions/cs_2/expire')

    respond = () => ({
      status: 400,
      body: { error: { message: 'You cannot expire a completed session.' } },
    })
    await assert.rejects(() => p.cancelPayment('cs_2'), /cannot expire/)
  })

  it('refunds through the session payment intent', async () => {
    const p = stripeProvider('sk_test_abc')
    respond = (path) =>
      path.includes('/checkout/sessions/')
        ? { status: 200, body: { payment_intent: 'pi_9' } }
        : { status: 200, body: { id: 're_1' } }
    await p.refund('cs_3')
    const req = captured.at(-1)!
    assert.equal(req.path, '/v1/refunds')
    assert.equal(req.body.get('payment_intent'), 'pi_9')
  })

  it('resumes the hosted checkout url', async () => {
    const p = stripeProvider('sk_test_abc')
    respond = () => ({ status: 200, body: { url: 'https://checkout.stripe.com/pay/x' } })
    assert.equal(await p.resumeUrl('cs_4'), 'https://checkout.stripe.com/pay/x')
    respond = () => ({ status: 200, body: { url: null } })
    assert.equal(await p.resumeUrl('cs_4'), null)
  })
})
