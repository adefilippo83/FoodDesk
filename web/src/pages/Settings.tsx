import { useEffect, useRef, useState } from 'react'
import {
  ApiError,
  api,
  formatMoney,
  parseMoney,
  type AppSettings,
  type CategoryStyle,
  type PaperSize,
} from '../api'
import { useI18n } from '../i18n'

const MAX_IMAGE_BYTES = 700 * 1024
const FONT_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24]
const IMAGE_WIDTHS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

function ImageField({
  label,
  value,
  onChange,
  onError,
  widthPct,
  onWidthChange,
}: {
  label: string
  value: string
  onChange: (dataUrl: string) => void
  onError: (msg: string) => void
  /** When set (with onWidthChange), a % selector appears next to the image. */
  widthPct?: number
  onWidthChange?: (pct: number) => void
}) {
  const { t } = useI18n()
  const fileRef = useRef<HTMLInputElement>(null)

  function pick(file: File | undefined) {
    if (!file) return
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > MAX_IMAGE_BYTES) {
      onError(t('errImageTooLarge'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => onChange(String(reader.result))
    reader.readAsDataURL(file)
  }

  return (
    <div className="field">
      <span
        style={{
          display: 'block',
          fontSize: 13,
          color: 'var(--text-dim)',
          marginBottom: 6,
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <div className="row">
        {value && (
          <img
            src={value}
            alt=""
            style={{
              height: 48,
              maxWidth: 120,
              objectFit: 'contain',
              borderRadius: 8,
              background: '#fff',
              padding: 2,
            }}
          />
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          style={{ display: 'none' }}
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <button className="btn small" onClick={() => fileRef.current?.click()}>
          {t('uploadImage')}
        </button>
        {value && (
          <button className="btn small danger" onClick={() => onChange('')}>
            {t('removeImage')}
          </button>
        )}
        {value && widthPct !== undefined && onWidthChange && (
          <select
            className="input"
            style={{ width: 'auto', minHeight: 36, padding: '0 8px' }}
            title={t('imageWidthLabel')}
            aria-label={t('imageWidthLabel')}
            value={widthPct}
            onChange={(e) => onWidthChange(Number(e.target.value))}
          >
            {IMAGE_WIDTHS.map((p) => (
              <option key={p} value={p}>
                {p}%
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

function PaperSizeSelect({ value, onSave }: { value: PaperSize; onSave: (p: PaperSize) => void }) {
  const { t } = useI18n()
  return (
    <label className="field" style={{ flex: '1 1 180px' }}>
      <span>{t('paperSize')}</span>
      <select
        className="input"
        value={value}
        onChange={(e) => onSave(e.target.value as PaperSize)}
      >
        <option value="roll80">{t('paperRoll80')}</option>
        <option value="a5">A5</option>
        <option value="a4">A4</option>
        <option value="letter">Letter</option>
      </select>
    </label>
  )
}

function FontSizeSelect({ value, onSave }: { value: number; onSave: (pt: number) => void }) {
  const { t } = useI18n()
  return (
    <label className="field" style={{ flex: '0 0 130px' }}>
      <span>{t('fontSizeLabel')}</span>
      <select className="input" value={value} onChange={(e) => onSave(Number(e.target.value))}>
        {FONT_SIZES.map((n) => (
          <option key={n} value={n}>
            {n} pt
          </option>
        ))}
      </select>
    </label>
  )
}

export default function Settings() {
  const { t } = useI18n()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [coverInput, setCoverInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setSettings(s)
        setCoverInput((s.coverChargeCents / 100).toFixed(2))
      })
      .catch(() => setError(t('errSaveSettings')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2000)
    return () => clearTimeout(timer)
  }, [toast])

  async function save(patch: Partial<AppSettings>) {
    setSaving(true)
    setError(null)
    try {
      const next = await api.saveSettings(patch)
      setSettings(next)
      setToast(t('settingsSaved'))
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'image_too_large'
          ? t('errImageTooLarge')
          : t('errSaveSettings'),
      )
    } finally {
      setSaving(false)
    }
  }

  if (!settings) return <div className="empty">{t('loading')}</div>

  return (
    <>
      <h1>{t('navSettings')}</h1>
      {error && <div className="error">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>{t('settingsGeneral')}</h2>

        <label className="field">
          <span>{t('name')}</span>
          <input
            className="input"
            value={settings.restaurantName}
            onChange={(e) => setSettings({ ...settings, restaurantName: e.target.value })}
            onBlur={() => void save({ restaurantName: settings.restaurantName })}
          />
        </label>

        <label className="field">
          <span>
            {t('coverChargeAmount')} — €{formatMoney(settings.coverChargeCents)}
          </span>
          <input
            className="input"
            style={{ maxWidth: 140 }}
            inputMode="decimal"
            value={coverInput}
            onChange={(e) => setCoverInput(e.target.value)}
            onBlur={() => {
              const cents = parseMoney(coverInput)
              if (cents === null) return setError(t('errPriceFormat'))
              void save({ coverChargeCents: cents })
            }}
          />
        </label>

        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <input
            type="checkbox"
            checked={settings.customerOrdering}
            onChange={(e) => void save({ customerOrdering: e.target.checked })}
            style={{ width: 20, height: 20 }}
          />
          <span>{t('selfOrderingLabel')}</span>
        </label>
        {settings.customerOrdering && (
          <>
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
              {t('selfOrderingHint')} <code>{window.location.origin}/order</code>
              <br />
              {t('onlinePaymentsLabel')}{' '}
              {(settings.paymentProviders ?? []).length > 0
                ? (settings.paymentProviders ?? []).join(', ') + ' ✓'
                : t('onlinePaymentsNone')}
            </p>
            <a
              className="btn"
              href="/api/settings/customer-qr.pdf"
              target="_blank"
              rel="noreferrer"
            >
              {t('printCustomerQr')}
            </a>
          </>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>{t('settingsPrintReceipt')}</h2>

        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 4 }}>
          <PaperSizeSelect
            value={settings.paperSize}
            onSave={(p) => void save({ paperSize: p })}
          />

          <label className="field" style={{ flex: '1 1 140px' }}>
            <span>{t('pdfLangLabel')}</span>
            <select
              className="input"
              value={settings.pdfLang}
              onChange={(e) => void save({ pdfLang: e.target.value as AppSettings['pdfLang'] })}
            >
              <option value="it">Italiano</option>
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="pt">Português</option>
            </select>
          </label>
        </div>

        <label className="field">
          <span>{t('headerTextLabel')}</span>
          <input
            className="input"
            value={settings.headerText}
            onChange={(e) => setSettings({ ...settings, headerText: e.target.value })}
            onBlur={() => void save({ headerText: settings.headerText })}
          />
        </label>

        <label className="field">
          <span>{t('footerTextLabel')}</span>
          <input
            className="input"
            value={settings.footerText}
            onChange={(e) => setSettings({ ...settings, footerText: e.target.value })}
            onBlur={() => void save({ footerText: settings.footerText })}
          />
        </label>

        <ImageField
          label={t('logoLabel')}
          value={settings.logoImage}
          onChange={(v) => void save({ logoImage: v })}
          onError={setError}
        />
        <ImageField
          label={t('backgroundLabel')}
          value={settings.backgroundImage}
          onChange={(v) => void save({ backgroundImage: v })}
          onError={setError}
        />

        <div className="row" style={{ marginTop: 8 }}>
          <a
            className="btn"
            href={api.settingsPreviewUrl('receipt')}
            target="_blank"
            rel="noreferrer"
          >
            {t('previewReceipt')}
          </a>
          {saving && <span className="muted">{t('sending')}</span>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>{t('settingsPrintOrder')}</h2>

        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 4 }}>
          <PaperSizeSelect
            value={settings.orderPaperSize}
            onSave={(p) => void save({ orderPaperSize: p })}
          />
        </div>

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label className="field" style={{ flex: 1 }}>
            <span>{t('orderHeaderTextLabel')}</span>
            <textarea
              className="input"
              rows={2}
              value={settings.orderHeaderText}
              onChange={(e) => setSettings({ ...settings, orderHeaderText: e.target.value })}
              onBlur={() => void save({ orderHeaderText: settings.orderHeaderText })}
            />
          </label>
          <FontSizeSelect
            value={settings.orderHeaderFontSize}
            onSave={(pt) => void save({ orderHeaderFontSize: pt })}
          />
        </div>
        <ImageField
          label={t('orderHeaderImageLabel')}
          value={settings.orderHeaderImage}
          onChange={(v) => void save({ orderHeaderImage: v })}
          onError={setError}
          widthPct={settings.orderHeaderImageWidthPct}
          onWidthChange={(p) => void save({ orderHeaderImageWidthPct: p })}
        />

        <label className="field">
          <span>{t('categoryStyleLabel')}</span>
          <select
            className="input"
            style={{ maxWidth: 280 }}
            value={settings.orderCategoryStyle}
            onChange={(e) => void save({ orderCategoryStyle: e.target.value as CategoryStyle })}
          >
            <option value="alternating">{t('categoryStyleAlternating')}</option>
            <option value="separator">{t('categoryStyleSeparator')}</option>
          </select>
        </label>

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label className="field" style={{ flex: 1 }}>
            <span>{t('disclaimerLabel')}</span>
            <textarea
              className="input"
              rows={3}
              value={settings.orderDisclaimer}
              onChange={(e) => setSettings({ ...settings, orderDisclaimer: e.target.value })}
              onBlur={() => void save({ orderDisclaimer: settings.orderDisclaimer })}
            />
          </label>
          <FontSizeSelect
            value={settings.orderDisclaimerFontSize}
            onSave={(pt) => void save({ orderDisclaimerFontSize: pt })}
          />
        </div>

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label className="field" style={{ flex: 1 }}>
            <span>{t('orderFooterTextLabel')}</span>
            <textarea
              className="input"
              rows={2}
              value={settings.orderFooterText}
              onChange={(e) => setSettings({ ...settings, orderFooterText: e.target.value })}
              onBlur={() => void save({ orderFooterText: settings.orderFooterText })}
            />
          </label>
          <FontSizeSelect
            value={settings.orderFooterFontSize}
            onSave={(pt) => void save({ orderFooterFontSize: pt })}
          />
        </div>
        <ImageField
          label={t('orderFooterImageLabel')}
          value={settings.orderFooterImage}
          onChange={(v) => void save({ orderFooterImage: v })}
          onError={setError}
          widthPct={settings.orderFooterImageWidthPct}
          onWidthChange={(p) => void save({ orderFooterImageWidthPct: p })}
        />

        <div className="row" style={{ marginTop: 8 }}>
          <a className="btn" href={api.settingsPreviewUrl('order')} target="_blank" rel="noreferrer">
            {t('previewOrderSheet')}
          </a>
          {saving && <span className="muted">{t('sending')}</span>}
        </div>
      </div>

      <div className="card">
        <h2>{t('settingsPrintKitchen')}</h2>

        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 4 }}>
          <PaperSizeSelect
            value={settings.kitchenPaperSize}
            onSave={(p) => void save({ kitchenPaperSize: p })}
          />
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <a
            className="btn"
            href={api.settingsPreviewUrl('kitchen')}
            target="_blank"
            rel="noreferrer"
          >
            {t('previewKitchenTicket')}
          </a>
          {saving && <span className="muted">{t('sending')}</span>}
        </div>
      </div>

      <p className="muted" style={{ marginTop: 16, textAlign: 'center', fontSize: 13 }}>
        FoodDesk · {t('versionLabel')} {settings.version}
      </p>

      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
