import { readFileSync } from 'node:fs'
import type { Db } from './db/index.js'
import { settings } from './db/schema.js'

/**
 * Admin-editable configuration, stored as key/value rows. Environment
 * variables act as defaults for a fresh install; once an admin saves a value
 * in the UI, the database wins.
 */

/** The running release, from the server package.json (issue #33). */
export const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown
    }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

export const PAPER_SIZES = ['roll80', 'a5', 'a4', 'letter'] as const
export type PaperSize = (typeof PAPER_SIZES)[number]

export const PDF_LANGS = ['it', 'en', 'es', 'fr', 'pt'] as const
export type PdfLang = (typeof PDF_LANGS)[number]

// How the order sheet visually separates one category of products from the next.
export const CATEGORY_STYLES = ['alternating', 'separator'] as const
export type CategoryStyle = (typeof CATEGORY_STYLES)[number]

export type AppSettings = {
  restaurantName: string
  coverChargeCents: number
  /** Customer self-ordering (phase A): the public /order flow. Default off. */
  customerOrdering: boolean
  /** Receipt paper. The legacy shared key — order/kitchen fall back to it. */
  paperSize: PaperSize
  /** Order sheet (foglio ordine) paper — issue #34. */
  orderPaperSize: PaperSize
  /** Kitchen ticket (foglio cucina) paper — issue #35. */
  kitchenPaperSize: PaperSize
  pdfLang: PdfLang
  headerText: string
  footerText: string
  /** data: URLs (image/png or image/jpeg), empty string = none */
  logoImage: string
  backgroundImage: string
  // Order sheet (foglio ordine) — the document handed out when an order is taken.
  orderHeaderText: string
  orderHeaderImage: string
  orderFooterText: string
  orderFooterImage: string
  orderDisclaimer: string
  orderCategoryStyle: CategoryStyle
  /** Font sizes in points. */
  orderHeaderFontSize: number
  orderFooterFontSize: number
  orderDisclaimerFontSize: number
  /** Width of the header/footer image as a % of the printable width. */
  orderHeaderImageWidthPct: number
  orderFooterImageWidthPct: number
}

const DEFAULTS: AppSettings = {
  restaurantName: process.env.RESTAURANT_NAME ?? 'FoodDesk',
  coverChargeCents: 0,
  customerOrdering: false,
  paperSize: 'roll80',
  orderPaperSize: 'roll80',
  kitchenPaperSize: 'roll80',
  pdfLang: (PDF_LANGS as readonly string[]).includes(process.env.PDF_LANG ?? '')
    ? (process.env.PDF_LANG as PdfLang)
    : 'it',
  headerText: '',
  footerText: '',
  logoImage: '',
  backgroundImage: '',
  orderHeaderText: '',
  orderHeaderImage: '',
  orderFooterText: '',
  orderFooterImage: '',
  orderDisclaimer: '',
  orderCategoryStyle: 'alternating',
  orderHeaderFontSize: 10,
  orderFooterFontSize: 9,
  orderDisclaimerFontSize: 8,
  orderHeaderImageWidthPct: 100,
  orderFooterImageWidthPct: 100,
}

// Bounds for the admin-tunable numeric settings of the order sheet.
const INT_SETTINGS = [
  ['orderHeaderFontSize', 6, 36],
  ['orderFooterFontSize', 6, 36],
  ['orderDisclaimerFontSize', 6, 36],
  ['orderHeaderImageWidthPct', 10, 100],
  ['orderFooterImageWidthPct', 10, 100],
] as const

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
  const selfOrder = map.get('customerOrdering')
  if (selfOrder !== undefined) s.customerOrdering = selfOrder === 'on'
  const paper = map.get('paperSize')
  if (paper && (PAPER_SIZES as readonly string[]).includes(paper)) s.paperSize = paper as PaperSize
  // Installs that predate per-document sizes shared one paperSize for every
  // printed document — keep that behavior until each size is saved on its own.
  s.orderPaperSize = s.paperSize
  s.kitchenPaperSize = s.paperSize
  for (const key of ['orderPaperSize', 'kitchenPaperSize'] as const) {
    const v = map.get(key)
    if (v && (PAPER_SIZES as readonly string[]).includes(v)) s[key] = v as PaperSize
  }
  const lang = map.get('pdfLang')
  if (lang && (PDF_LANGS as readonly string[]).includes(lang)) s.pdfLang = lang as PdfLang
  const catStyle = map.get('orderCategoryStyle')
  if (catStyle && (CATEGORY_STYLES as readonly string[]).includes(catStyle)) {
    s.orderCategoryStyle = catStyle as CategoryStyle
  }
  for (const [key, min, max] of INT_SETTINGS) {
    const v = Number(map.get(key))
    if (Number.isInteger(v) && v >= min && v <= max) s[key] = v
  }
  for (const key of [
    'headerText',
    'footerText',
    'logoImage',
    'backgroundImage',
    'orderHeaderText',
    'orderHeaderImage',
    'orderFooterText',
    'orderFooterImage',
    'orderDisclaimer',
  ] as const) {
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
  if (patch.customerOrdering !== undefined) {
    if (typeof patch.customerOrdering !== 'boolean') {
      return { field: 'customerOrdering', error: 'invalid_flag' }
    }
    writes.push(['customerOrdering', patch.customerOrdering ? 'on' : 'off'])
  }
  for (const key of ['paperSize', 'orderPaperSize', 'kitchenPaperSize'] as const) {
    if (patch[key] === undefined) continue
    if (!(PAPER_SIZES as readonly string[]).includes(patch[key] as string)) {
      return { field: key, error: 'invalid_paper_size' }
    }
    writes.push([key, patch[key] as string])
  }
  if (patch.pdfLang !== undefined) {
    if (!(PDF_LANGS as readonly string[]).includes(patch.pdfLang as string)) {
      return { field: 'pdfLang', error: 'invalid_lang' }
    }
    writes.push(['pdfLang', patch.pdfLang as string])
  }
  if (patch.orderCategoryStyle !== undefined) {
    if (!(CATEGORY_STYLES as readonly string[]).includes(patch.orderCategoryStyle as string)) {
      return { field: 'orderCategoryStyle', error: 'invalid_category_style' }
    }
    writes.push(['orderCategoryStyle', patch.orderCategoryStyle as string])
  }
  for (const [key, min, max] of INT_SETTINGS) {
    const v = patch[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      return { field: key, error: 'invalid_number' }
    }
    writes.push([key, String(v)])
  }
  for (const key of ['headerText', 'footerText', 'orderHeaderText', 'orderFooterText'] as const) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'string') return { field: key, error: 'invalid_text' }
      writes.push([key, (patch[key] as string).slice(0, 300)])
    }
  }
  if (patch.orderDisclaimer !== undefined) {
    if (typeof patch.orderDisclaimer !== 'string') {
      return { field: 'orderDisclaimer', error: 'invalid_text' }
    }
    writes.push(['orderDisclaimer', patch.orderDisclaimer.slice(0, 500)])
  }
  for (const key of ['logoImage', 'backgroundImage', 'orderHeaderImage', 'orderFooterImage'] as const) {
    const v = patch[key]
    if (v === undefined) continue
    if (v === '') {
      writes.push([key, '']) // explicit removal
      continue
    }
    if (typeof v !== 'string' || !DATA_URL_RE.test(v)) {
      return { field: key, error: 'invalid_image' }
    }
    const buf = Buffer.from(v.split(',')[1]!, 'base64')
    if (buf.length > MAX_IMAGE_BYTES) return { field: key, error: 'image_too_large' }
    // The claimed MIME type must match the actual bytes, not just the label.
    const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47
    const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    const declaredPng = v.startsWith('data:image/png')
    if ((declaredPng && !isPng) || (!declaredPng && !isJpeg)) {
      return { field: key, error: 'invalid_image' }
    }
    writes.push([key, v])
  }

  // All or nothing: a failure part-way through the loop would otherwise leave
  // half a settings page saved, which is how you get a receipt with the new
  // logo and the old paper size.
  db.transaction((tx) => {
    for (const [key, value] of writes) {
      tx.insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run()
    }
  })
  return null
}

export function imageBuffer(dataUrl: string): Buffer | null {
  const b64 = dataUrl.split(',')[1]
  return b64 ? Buffer.from(b64, 'base64') : null
}
