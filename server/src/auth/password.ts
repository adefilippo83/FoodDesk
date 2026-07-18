import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>

// Node's built-in scrypt: no native module to compile on the Debian box.
const PARAMS = { N: 16384, r: 8, p: 1 }
const KEYLEN = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, KEYLEN, PARAMS)
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, keyB64] = parts
  const salt = Buffer.from(saltB64!, 'base64')
  const expected = Buffer.from(keyB64!, 'base64')
  const actual = await scryptAsync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
