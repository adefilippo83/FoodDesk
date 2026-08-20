import { useEffect, useState } from 'react'
import { api, formatMoney, type DailyReport } from '../api'
import { useI18n } from '../i18n'
import { paymentLabel } from '../lib/paymentLabel'

function Breakdown({
  title,
  rows,
  unitLabel,
}: {
  title: string
  rows: { name: string; qty?: number; ordersCount?: number; revenueCents: number }[]
  unitLabel: string
}) {
  const { t } = useI18n()
  return (
    <div className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">{t('nothingSold')}</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th className="num">{unitLabel}</th>
                <th className="num">{t('revenue')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="num">{r.qty ?? r.ordersCount}</td>
                  <td className="num">€{formatMoney(r.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function Reports() {
  const { t } = useI18n()
  const [days, setDays] = useState<{ serviceDay: string; ordersCount: number }[]>([])
  const [day, setDay] = useState<string>('')
  const [report, setReport] = useState<DailyReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .reportDays()
      .then((d) => {
        setDays(d)
        setDay((cur) => cur || (d[0]?.serviceDay ?? ''))
      })
      .catch(() => setError(t('errLoadReportDays')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!day) return
    api
      .dailyReport(day)
      .then(setReport)
      .catch(() => setError(t('errLoadReport')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day])

  if (days.length === 0 && !error) {
    return <div className="empty">{t('noReportsYet')}</div>
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('navReports')}</h1>
        <select
          className="input"
          style={{ width: 'auto', marginLeft: 'auto' }}
          value={day}
          onChange={(e) => setDay(e.target.value)}
        >
          {days.map((d) => (
            <option key={d.serviceDay} value={d.serviceDay}>
              {d.serviceDay} ({d.ordersCount}{' '}
              {d.ordersCount === 1 ? t('orderSingular') : t('orderPlural')})
            </option>
          ))}
        </select>
        {day && (
          <>
            <a className="btn" href={api.dailyCsvUrl(day)}>
              {t('downloadCsv')}
            </a>
            <a className="btn" href={api.dailyPdfUrl(day)}>
              {t('downloadPdf')}
            </a>
          </>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {report && (
        <>
          <div className="stat-row">
            <div className="card stat">
              <span className="muted">{t('navOrders')}</span>
              <strong>{report.ordersCount}</strong>
            </div>
            <div className="card stat">
              <span className="muted">{t('revenue')}</span>
              <strong>€{formatMoney(report.revenueCents)}</strong>
            </div>
            <div className="card stat">
              <span className="muted">{t('coversStat')}</span>
              <strong>{report.totalCovers}</strong>
            </div>
            {report.avgPerCoverCents !== null && (
              <div className="card stat">
                <span className="muted">{t('avgPerCover')}</span>
                <strong>€{formatMoney(report.avgPerCoverCents)}</strong>
              </div>
            )}
            {report.cancelledCount > 0 && (
              <div className="card stat">
                <span className="muted">{t('cancelledStat')}</span>
                <strong>{report.cancelledCount}</strong>
              </div>
            )}
            {report.refundedCount > 0 && (
              <div className="card stat">
                <span className="muted">{t('refundedStat')}</span>
                <strong>€{formatMoney(report.refundedCents)}</strong>
              </div>
            )}
          </div>

          <div className="report-grid">
            <Breakdown
              title={t('byPayment')}
              rows={(report.byPayment ?? []).map((p) => ({
                name: paymentLabel(p.method, t),
                ordersCount: p.ordersCount,
                revenueCents: p.revenueCents,
              }))}
              unitLabel={t('navOrders')}
            />
            <Breakdown title={t('byProduct')} rows={report.byProduct} unitLabel={t('qty')} />
            <Breakdown title={t('byCategory')} rows={report.byCategory} unitLabel={t('qty')} />
          </div>
        </>
      )}
    </>
  )
}
