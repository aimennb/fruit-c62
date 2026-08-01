// Liste des dépenses de la journée (drill-down /caisse/:date).
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getCashDayExpenses, type CashDayExpense } from '../api'
import { useLang } from '../i18n'
import { PageHeader, Button, Table, Spinner, ErrorBox, EmptyState, Badge } from '../components/ui'
import { fmtDA, fmtDate } from './caisse-utils'

export default function CaisseExpenses() {
  const { date } = useParams<{ date: string }>()
  const navigate = useNavigate()
  const { lang } = useLang()
  const [items, setItems] = useState<CashDayExpense[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!date) return
    setLoading(true)
    getCashDayExpenses(date)
      .then((r) => setItems(r.items))
      .catch((e: any) => setError(e?.message ?? 'Erreur de chargement'))
      .finally(() => setLoading(false))
  }, [date])

  const ar = lang === 'ar'
  const total = items
    .filter((d) => d.status !== 'annulee')
    .reduce((s, i) => s + Number(i.amount || 0), 0)

  return (
    <div>
      <PageHeader
        title={ar ? `مصاريف يوم ${fmtDate(date)}` : `Dépenses du ${fmtDate(date)}`}
        subtitle={ar ? 'كل مصاريف اليوم' : 'Toutes les dépenses de la journée'}
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
        <EmptyState message={ar ? 'لا توجد مصاريف لهذا اليوم.' : 'Aucune dépense pour cette journée.'} />
      ) : (
        <>
          <div className="mb-3 text-sm text-gray-500">
            {items.length} {ar ? 'مصروف' : 'dépense(s)'} — {ar ? 'المجموع' : 'Total'} :{' '}
            <span className="font-bold text-red-600">{fmtDA(total)}</span>
          </div>
          <Table
            headers={[
              ar ? 'السبب' : 'Motif',
              ar ? 'الصنف' : 'Catégorie',
              ar ? 'المبلغ' : 'Montant',
              ar ? 'طريقة الدفع' : 'Mode',
              ar ? 'الساعة' : 'Heure',
              ar ? 'الحالة' : 'Statut',
            ]}
          >
            {items.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">{d.motif}</td>
                <td className="px-4 py-3 text-gray-600">{d.category ?? '—'}</td>
                <td className="px-4 py-3 font-semibold text-red-600">{fmtDA(d.amount)}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{d.paymentMethod}</td>
                <td className="px-4 py-3 text-gray-500">{d.heure ?? '—'}</td>
                <td className="px-4 py-3">
                  <Badge color={d.status === 'annulee' ? 'gray' : 'green'}>
                    {d.status === 'annulee' ? (ar ? 'ملغاة' : 'Annulée') : ar ? 'مثبتة' : 'Validée'}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  )
}
