import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listSupplierPayments, openSupplierPaymentPdf, type SupplierPaymentRow } from '../api'
import { PageHeader, Card, Button, Table, Spinner, ErrorBox, EmptyState, Badge } from '../components/ui'
import { useLang } from '../i18n'

export default function SupplierPaymentsPage() {
  const { lang } = useLang()
  const ar = lang === 'ar'
  const navigate = useNavigate()

  const [items, setItems] = useState<SupplierPaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    listSupplierPayments()
      .then((r) => setItems(r.items ?? []))
      .catch((e) => setError(e?.message ?? 'Erreur'))
      .finally(() => setLoading(false))
  }, [])

  const headers = ar
    ? ['التاريخ', 'المرجع', 'المورد', 'المبلغ', 'النوع', '']
    : ['Date', 'Réf.', 'Fournisseur', 'Montant total', 'Mode', '']

  return (
    <div>
      <PageHeader
        title={ar ? 'دفع الموردين' : 'Paiement fournisseur'}
        subtitle={ar ? 'سندات الدفع للموردين' : 'Bons de paiement fournisseurs (BP)'}
        actions={
          <Button onClick={() => navigate('/paiements-fournisseur/nouveau')}>
            {ar ? 'جديد' : 'Nouveau'}
          </Button>
        }
      />
      {error && <ErrorBox message={error} />}
      {loading ? (
        <Spinner label={ar ? 'جاري التحميل' : 'Chargement...'} />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState message={ar ? 'لا توجد سندات دفع' : 'Aucun bon de paiement'} />
        </Card>
      ) : (
        <Table headers={headers}>
          {items.map((p) => (
            <tr key={p.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 whitespace-nowrap">{new Date(p.date).toLocaleDateString('fr-FR')}</td>
              <td className="px-4 py-3 font-semibold text-gray-800 whitespace-nowrap">{p.reference}</td>
              <td className="px-4 py-3 whitespace-nowrap">{p.supplierName}</td>
              <td className="px-4 py-3 text-right whitespace-nowrap font-semibold text-fruite-green">
                {Number(p.totalAmount).toFixed(2)} DA
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <Badge color={p.mode === 'PAY' ? 'blue' : 'amber'}>
                  {p.mode === 'PAY' ? (ar ? 'دفع' : 'Payer') : ar ? 'تحصيل' : 'Encaisser'}
                </Badge>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2 justify-end">
                  <Button variant="secondary" className="px-3" onClick={() => navigate(`/paiements-fournisseur/${p.id}`)}>
                    {ar ? 'عرض' : 'Voir'}
                  </Button>
                  <Button variant="ghost" className="px-3" onClick={() => openSupplierPaymentPdf(p.id)}>
                    PDF
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}
