import { eq } from 'drizzle-orm'
import type { Db } from './db/index.js'
import { settings } from './db/schema.js'

/**
 * Admin-editable configuration, stored as key/value rows. Environment
 * variables act as defaults for a fresh install; once an admin saves a value
 * in the UI, the database wins.
 */

export const PAPER_SIZES = ['roll80', 'a5', 'a4', 'letter'] as const
export type PaperSize = (typeof PAPER_SIZES)[number]

export const PDF_LANGS = ['it', 'en', 'es', 'fr', 'pt'] as const
export type PdfLang = (typeof PDF_LANGS)[number]

export type AppSettings = {
  restaurantName: string
  coverChargeCents: number
  paperSize: PaperSize
  pdfLang: PdfLang
  headerText: string
  footerText: string
  /** data: URLs (image/png or image/jpeg), empty string = none */
  logoImage: string
  backgroundImage: string
}

const DEFAULTS: AppSettings = {
  restaurantName: process.env.RESTAURANT_NAME ?? 'FoodDesk',
  coverChargeCents: 0,
  paperSize: 'roll80',
  pdfLang: (PDF_LANGS as readonly string[]).includes(process.env.PDF_LANG ?? '')
    ? (process.env.PDF_LANG as PdfLang)
    : 'it',
  headerText: '',
  footerText: '',
  logoImage: '',
  backgroundImage: '',
}

// Uploaded images ride along in JSON bodies; keep them phone-photo-proof.
export const MAX_IMAGE_BYTES = 700 * 1024
const DATA_URL_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/

export async function loadSettings(db: Db): Promise<AppSettings> {
  const rows = await db.select().from(settings)
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const s = { ...DEFAULTS }

  const name = map.get('restaurantName')
  if (name) s.restaurantName = name
  const cover = Number(map.get('coverChargeCents'))
  if (Number.isInteger(cover) && cover >= 0) s.coverChargeCents = cover
  const paper = map.get('paperSize')
  if (paper && (PAPER_SIZES as readonly string[]).includes(paper)) s.paperSize = paper as PaperSize
  const lang = map.get('pdfLang')
  if (lang && (PDF_LANGS as readonly string[]).includes(lang)) s.pdfLang = lang as PdfLang
  for (const key of ['headerText', 'footerText', 'logoImage', 'backgroundImage'] as const) {
    const v = map.get(key)
    if (v !== undefined) s[key] = v
  }
  return s
}

export type SettingsPatchError = { field: string; error: string }

/** Validates and persists a partial update. Returns null on success. */
export async function saveSettings(
  db: Db,
  patch: Record<string, unknown>,
): Promise<SettingsPatchError | null> {
  const writes: Array<[string, string]> = []

  if (patch.restaurantName !== undefined) {
    if (typeof patch.restaurantName !== 'string' || !patch.restaurantName.trim()) {
      return { field: 'restaurantName', error: 'invalid_name' }
    }
    writes.push(['restaurantName', patch.restaurantName.trim().slice(0, 60)])
  }
  if (patch.coverChargeCents !== undefined) {
    const v = patch.coverChargeCents
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100_00) {
      return { field: 'coverChargeCents', error: 'invalid_amount' }
    }
    writes.push(['coverChargeCents', String(v)])
  }
  if (patch.paperSize !== undefined) {
    if (!(PAPER_SIZES as readonly string[]).includes(patch.paperSize as string)) {
      return { field: 'paperSize', error: 'invalid_paper_size' }
    }
    writes.push(['paperSize', patch.paperSize as string])
  }
  if (patch.pdfLang !== undefined) {
    if (!(PDF_LANGS as readonly string[]).includes(patch.pdfLang as string)) {
      return { field: 'pdfLang', error: 'invalid_lang' }
    }
    writes.push(['pdfLang', patch.pdfLang as string])
  }
  for (const key of ['headerText', 'footerText'] as const) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'string') return { field: key, error: 'invalid_text' }
      writes.push([key, (patch[key] as string).slice(0, 300)])
    }
  }
  for (const key of ['logoImage', 'backgroundImage'] as const) {
    const v = patch[key]
    if (v === undefined) continue
    if (v === '') {
      writes.push([key, '']) // explicit removal
      continue
    }
    if (typeof v !== 'string' || !DATA_URL_RE.test(v)) {
      return { field: key, error: 'invalid_image' }
    }
    const bytes = Buffer.byteLength(v.split(',')[1]!, 'base64')
    if (bytes > MAX_IMAGE_BYTES) return { field: key, error: 'image_too_large' }
    writes.push([key, v])
  }

  for (const [key, value] of writes) {
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
  }
  return null
}

export function imageBuffer(dataUrl: string): Buffer | null {
  const b64 = dataUrl.split(',')[1]
  return b64 ? Buffer.from(b64, 'base64') : null
}
