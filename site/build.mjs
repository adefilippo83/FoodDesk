/**
 * Builds the static site into site/dist: one page per app language
 * (en at /, the others at /<lang>/), from template.html + strings.mjs.
 * No dependencies — run with `node site/build.mjs`.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { en, languages } from './strings.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const dist = join(root, 'dist')
const template = readFileSync(join(root, 'template.html'), 'utf8')

// English is the reference: a language missing a key fails the build,
// mirroring how the app's typed i18n dictionary stays complete.
const required = Object.keys(en)
for (const [lang, strings] of Object.entries(languages)) {
  const missing = required.filter((k) => !(k in strings))
  if (missing.length) throw new Error(`${lang} is missing keys: ${missing.join(', ')}`)
}

const pathOf = (lang) => (lang === 'en' ? '/' : `/${lang}/`)

const alternates = [
  ...Object.keys(languages).map(
    (l) => `<link rel="alternate" hreflang="${l}" href="https://fooddesk.shop${pathOf(l)}" />`,
  ),
  '<link rel="alternate" hreflang="x-default" href="https://fooddesk.shop/" />',
].join('\n  ')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
cpSync(join(root, 'static'), dist, { recursive: true })

for (const [lang, strings] of Object.entries(languages)) {
  const langLinks = Object.keys(languages)
    .filter((l) => l !== lang)
    .map((l) => `<a class="lang" href="${pathOf(l)}" lang="${l}">${l.toUpperCase()}</a>`)
    .join('\n        ')

  const vars = {
    ...strings,
    lang,
    path: pathOf(lang),
    home: pathOf(lang),
    alternates,
    langLinks,
  }

  const html = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`template references unknown key "${key}"`)
    return vars[key]
  })

  const outDir = lang === 'en' ? dist : join(dist, lang)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'index.html'), html)
  console.log(`built ${pathOf(lang)}index.html (${strings.langName})`)
}
