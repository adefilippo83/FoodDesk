import { useEffect, useRef, useState } from 'react'
import { ApiError, api, formatMoney, parseMoney, type AppSettings, type PaperSize } from '../api'
import { useI18n } from '../i18n'

const MAX_IMAGE_BYTES = 700 * 1024

function ImageField({
  label,
  value,
  onChange,
  onError,
}: {
  label: string
  value: string
  onChange: (dataUrl: string) => void
  onError: (msg: string) => void
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
      </div>
    </div>
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
      </div>

      <div className="card">
        <h2>{t('settingsPrint')}</h2>

        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 4 }}>
          <label className="field" style={{ flex: '1 1 180px' }}>
            <span>{t('paperSize')}</span>
            <select
              className="input"
              value={settings.paperSize}
              onChange={(e) => void save({ paperSize: e.target.value as PaperSize })}
            >
              <option value="roll80">{t('paperRoll80')}</option>
              <option value="a5">A5</option>
              <option value="a4">A4</option>
              <option value="letter">Letter</option>
            </select>
          </label>

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
          <a className="btn" href={api.settingsPreviewUrl()} target="_blank" rel="noreferrer">
            {t('previewReceipt')}
          </a>
          {saving && <span className="muted">{t('sending')}</span>}
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
