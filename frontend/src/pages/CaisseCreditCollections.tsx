// Liste des encaissements de crédits clients du jour (drill-down /caisse/:date).
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getCashDayCreditCollections, type CashDayCreditCollection } from '../api'
import { useLang } from '../i18n'
import { PageHeader, Button, Table, Spinner, ErrorBox, EmptyState } from '../components/ui'
import { fmtDA, fmtDate } from './caisse-utils'

export default function CaisseCreditCollections() {
  const { date } = useParams<{ date: string }>()
  const navigate = useNavigate()
  const { lang } = useLang()
  const [items, setItems] = useState<CashDayCreditCollection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!date) return
    setLoading(true)
    getCashDayCreditCollections(date)
      .then((r) => setItems(r.items))
      .catch((e: any) => setError(e?.message ?? 'Erreur de chargement'))
      .finally(() => setLoading(false))
  }, [date])

  const ar = lang === 'ar'
  const total = items.reduce((s, i) => s + Number(i.amount || 0), 0)

  return (
    <div>
      <PageHeader
        title={ar ? `تحصيل الديون ليوم ${fmtDate(date)}` : `Encaissements de crédits du ${fmtDate(date)}`}
        subtitle={ar ? 'دفعات الزبائن على فواتير بالدين' : 'Paiements clients sur factures à crédit'}
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
        <EmptyState message={ar ? 'لا يوجد تحصيل لهذا اليوم.' : 'Aucun encaissement de crédit pour cette journée.'} />
      ) : (
        <>
          <div className="mb-3 text-sm text-gray-500">
            {items.length} {ar ? 'دفعة' : 'paiement(s)'} — {ar ? 'المجموع' : 'Total'} :{' '}
            <span className="font-bold text-green-600">{fmtDA(total)}</span>
          </div>
          <Table
            headers={[
              ar ? 'مرجع الدفع' : 'Réf. paiement',
              ar ? 'الفاتورة' : 'Facture',
              ar ? 'الزبون' : 'Client',
              ar ? 'المبلغ' : 'Montant',
              ar ? 'الطريقة' : 'Mode',
              ar ? 'الساعة' : 'Heure',
            ]}
          >
            {items.map((p) => (
              <tr
                key={p.id}
                className={`hover:bg-gray-50 ${p.invoiceId ? 'cursor-pointer' : ''}`}
                onClick={() => p.invoiceId && navigate(`/factures/${p.invoiceId}`)}
              >
                <td className="px-4 py-3 text-gray-600">{p.reference}</td>
                <td className="px-4 py-3 font-medium text-blue-600">{p.invoiceReference ?? '—'}</td>
                <td className="px-4 py-3 text-gray-800">{p.customerName ?? '—'}</td>
                <td className="px-4 py-3 font-semibold text-green-600">{fmtDA(p.amount)}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{p.method}</td>
                <td className="px-4 py-3 text-gray-500">
                  {new Date(p.paymentDate).toLocaleTimeString('fr-FR').slice(0, 5)}
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  )
}
