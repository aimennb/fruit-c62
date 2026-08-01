// Liste des remises d'espèces de la journée (drill-down /caisse/:date).
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getCashDayRemittances, type CashDayRemittance } from '../api'
import { useLang } from '../i18n'
import { PageHeader, Button, Table, Spinner, ErrorBox, EmptyState } from '../components/ui'
import { fmtDA, fmtDate } from './caisse-utils'

export default function CaisseRemittances() {
  const { date } = useParams<{ date: string }>()
  const navigate = useNavigate()
  const { lang } = useLang()
  const [items, setItems] = useState<CashDayRemittance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!date) return
    setLoading(true)
    getCashDayRemittances(date)
      .then((r) => setItems(r.items))
      .catch((e: any) => setError(e?.message ?? 'Erreur de chargement'))
      .finally(() => setLoading(false))
  }, [date])

  const ar = lang === 'ar'
  const total = items.reduce((s, i) => s + Number(i.amount || 0), 0)

  return (
    <div>
      <PageHeader
        title={ar ? `تسليمات نقدية ليوم ${fmtDate(date)}` : `Remises d'espèces du ${fmtDate(date)}`}
        subtitle={ar ? 'كل التسليمات النقدية لهذا اليوم' : 'Toutes les remises d\u2019espèces de la journée'}
        actions={
          <Button variant="secondary" onClick={() => navigate(`/caisse/${date}`)}>
            ← {ar ? 'رجوع' : 'Retour'}
          </Button>
        }
      />
      {loading ? (
        <Spinner label={ar ? 'جارٍ التحميل…' : 'Chargement…'} />
      ) : error ? (
        <ErrorBox message={error} />
      ) : items.length === 0 ? (
        <EmptyState message={ar ? 'لا توجد تسليمات لهذا اليوم.' : 'Aucune remise pour cette journée.'} />
      ) : (
        <>
          <div className="mb-3 text-sm text-gray-500">
            {items.length} {ar ? 'تسليم' : 'remise(s)'} — {ar ? 'المجموع' : 'Total'} :{' '}
            <span className="font-bold text-red-600">{fmtDA(total)}</span>
          </div>
          <Table
            headers={[
              ar ? 'المرجع' : 'Référence',
              ar ? 'المستفيد' : 'Bénéficiaire',
              ar ? 'السبب' : 'Motif',
              ar ? 'المبلغ' : 'Montant',
              ar ? 'الساعة' : 'Heure',
            ]}
          >
            {items.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-600">{r.reference}</td>
                <td className="px-4 py-3 text-gray-800">{r.beneficiary ?? '—'}</td>
                <td className="px-4 py-3 font-medium text-gray-800">{r.motif}</td>
                <td className="px-4 py-3 font-semibold text-red-600">{fmtDA(r.amount)}</td>
                <td className="px-4 py-3 text-gray-500">{r.heure ?? '—'}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  )
}
