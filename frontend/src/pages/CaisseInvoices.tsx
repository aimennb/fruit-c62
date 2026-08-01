// Liste des factures émises pour une journée de caisse (drill-down /caisse/:date).
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getCashDayInvoices, type CashDayInvoice } from '../api'
import { useLang } from '../i18n'
import { PageHeader, Button, Table, Spinner, ErrorBox, EmptyState, Badge } from '../components/ui'
import { fmtDA, fmtDate } from './caisse-utils'

export default function CaisseInvoices() {
  const { date } = useParams<{ date: string }>()
  const navigate = useNavigate()
  const { lang } = useLang()
  const [items, setItems] = useState<CashDayInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!date) return
    setLoading(true)
    getCashDayInvoices(date)
      .then((r) => setItems(r.items))
      .catch((e: any) => setError(e?.message ?? 'Erreur de chargement'))
      .finally(() => setLoading(false))
  }, [date])

  const ar = lang === 'ar'
  const total = items.reduce((s, i) => s + Number(i.total || 0), 0)

  return (
    <div>
      <PageHeader
        title={ar ? `فواتير يوم ${fmtDate(date)}` : `Factures du ${fmtDate(date)}`}
        subtitle={ar ? 'كل فواتير اليوم' : 'Toutes les factures émises ce jour'}
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
        <EmptyState message={ar ? 'لا توجد فواتير لهذا اليوم.' : 'Aucune facture pour cette journée.'} />
      ) : (
        <>
          <div className="mb-3 text-sm text-gray-500">
            {items.length} {ar ? 'فاتورة' : 'facture(s)'} — {ar ? 'المجموع' : 'Total'} :{' '}
            <span className="font-bold text-gray-800">{fmtDA(total)}</span>
          </div>
          <Table
            headers={[
              ar ? 'المرجع' : 'Référence',
              ar ? 'الزبون' : 'Client',
              ar ? 'المبلغ' : 'Montant',
              ar ? 'الحالة' : 'Statut',
              ar ? 'الساعة' : 'Heure',
            ]}
          >
            {items.map((f) => (
              <tr
                key={f.id}
                className="hover:bg-gray-50 cursor-pointer"
                onClick={() => navigate(`/factures/${f.id}`)}
              >
                <td className="px-4 py-3 font-medium text-blue-600">{f.reference}</td>
                <td className="px-4 py-3 text-gray-800">{f.customerName ?? '—'}</td>
                <td className="px-4 py-3 font-semibold text-gray-800">{fmtDA(f.total)}</td>
                <td className="px-4 py-3">
                  <Badge color={f.status === 'PAID' ? 'green' : f.status === 'OVERDUE' ? 'red' : 'blue'}>
                    {f.status}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {new Date(f.issueDate).toLocaleTimeString('fr-FR').slice(0, 5)}
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  )
}
