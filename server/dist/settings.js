import { settings } from './db/schema.js';
/**
 * Admin-editable configuration, stored as key/value rows. Environment
 * variables act as defaults for a fresh install; once an admin saves a value
 * in the UI, the database wins.
 */
export const PAPER_SIZES = ['roll80', 'a5', 'a4', 'letter'];
export const PDF_LANGS = ['it', 'en', 'es', 'fr', 'pt'];
const DEFAULTS = {
    restaurantName: process.env.RESTAURANT_NAME ?? 'FoodDesk',
    coverChargeCents: 0,
    paperSize: 'roll80',
    pdfLang: PDF_LANGS.includes(process.env.PDF_LANG ?? '')
        ? process.env.PDF_LANG
        : 'it',
    headerText: '',
    footerText: '',
    logoImage: '',
    backgroundImage: '',
};
// Uploaded images ride along in JSON bodies; keep them phone-photo-proof.
export const MAX_IMAGE_BYTES = 700 * 1024;
const DATA_URL_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
export async function loadSettings(db) {
    const rows = await db.select().from(settings);
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const s = { ...DEFAULTS };
    const name = map.get('restaurantName');
    if (name)
        s.restaurantName = name;
    const cover = Number(map.get('coverChargeCents'));
    if (Number.isInteger(cover) && cover >= 0)
        s.coverChargeCents = cover;
    const paper = map.get('paperSize');
    if (paper && PAPER_SIZES.includes(paper))
        s.paperSize = paper;
    const lang = map.get('pdfLang');
    if (lang && PDF_LANGS.includes(lang))
        s.pdfLang = lang;
    for (const key of ['headerText', 'footerText', 'logoImage', 'backgroundImage']) {
        const v = map.get(key);
        if (v !== undefined)
            s[key] = v;
    }
    return s;
}
/** Validates and persists a partial update. Returns null on success. */
export async function saveSettings(db, patch) {
    const writes = [];
    if (patch.restaurantName !== undefined) {
        if (typeof patch.restaurantName !== 'string' || !patch.restaurantName.trim()) {
            return { field: 'restaurantName', error: 'invalid_name' };
        }
        writes.push(['restaurantName', patch.restaurantName.trim().slice(0, 60)]);
    }
    if (patch.coverChargeCents !== undefined) {
        const v = patch.coverChargeCents;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100_00) {
            return { field: 'coverChargeCents', error: 'invalid_amount' };
        }
        writes.push(['coverChargeCents', String(v)]);
    }
    if (patch.paperSize !== undefined) {
        if (!PAPER_SIZES.includes(patch.paperSize)) {
            return { field: 'paperSize', error: 'invalid_paper_size' };
        }
        writes.push(['paperSize', patch.paperSize]);
    }
    if (patch.pdfLang !== undefined) {
        if (!PDF_LANGS.includes(patch.pdfLang)) {
            return { field: 'pdfLang', error: 'invalid_lang' };
        }
        writes.push(['pdfLang', patch.pdfLang]);
    }
    for (const key of ['headerText', 'footerText']) {
        if (patch[key] !== undefined) {
            if (typeof patch[key] !== 'string')
                return { field: key, error: 'invalid_text' };
            writes.push([key, patch[key].slice(0, 300)]);
        }
    }
    for (const key of ['logoImage', 'backgroundImage']) {
        const v = patch[key];
        if (v === undefined)
            continue;
        if (v === '') {
            writes.push([key, '']); // explicit removal
            continue;
        }
        if (typeof v !== 'string' || !DATA_URL_RE.test(v)) {
            return { field: key, error: 'invalid_image' };
        }
        const buf = Buffer.from(v.split(',')[1], 'base64');
        if (buf.length > MAX_IMAGE_BYTES)
            return { field: key, error: 'image_too_large' };
        // The claimed MIME type must match the actual bytes, not just the label.
        const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
        const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
        const declaredPng = v.startsWith('data:image/png');
        if ((declaredPng && !isPng) || (!declaredPng && !isJpeg)) {
            return { field: key, error: 'invalid_image' };
        }
        writes.push([key, v]);
    }
    for (const [key, value] of writes) {
        await db
            .insert(settings)
            .values({ key, value })
            .onConflictDoUpdate({ target: settings.key, set: { value } });
    }
    return null;
}
export function imageBuffer(dataUrl) {
    const b64 = dataUrl.split(',')[1];
    return b64 ? Buffer.from(b64, 'base64') : null;
}
