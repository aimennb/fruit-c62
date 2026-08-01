import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getSupplierPayment, openSupplierPaymentPdf, type SupplierPaymentDetailDTO } from '../api'
import { PageHeader, Card, Button, Table, Spinner, ErrorBox, Badge } from '../components/ui'
import { useLang } from '../i18n'

export default function SupplierPaymentDetail() {
  const { id } = useParams<{ id: string }>()
  const { lang } = useLang()
  const ar = lang === 'ar'
  const navigate = useNavigate()

  const [p, setP] = useState<SupplierPaymentDetailDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    getSupplierPayment(id)
      .then(setP)
      .catch((e) => setError(e?.message ?? 'Erreur'))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <Spinner label={ar ? 'جاري التحميل' : 'Chargement...'} />
  if (error) return <ErrorBox message={error} />
  if (!p) return null

  return (
    <div>
      <PageHeader
        title={`${ar ? 'سند دفع' : 'Bon de paiement'} ${p.reference}`}
        subtitle={p.supplier?.name ?? ''}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/paiements-fournisseur')}>
              {ar ? 'رجوع' : 'Retour'}
            </Button>
            <Button onClick={() => openSupplierPaymentPdf(p.id)}>PDF</Button>
          </>
        }
      />
      <Card className="mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-gray-500">{ar ? 'التاريخ' : 'Date'}</div>
            <div className="font-semibold">{new Date(p.date).toLocaleDateString('fr-FR')}</div>
          </div>
          <div>
            <div className="text-gray-500">Mode</div>
            <Badge color={p.mode === 'PAY' ? 'blue' : 'amber'}>
              {p.mode === 'PAY' ? 'Payer' : 'Encaisser'}
            </Badge>
          </div>
          <div>
            <div className="text-gray-500">{ar ? 'الطريقة' : 'Méthode'}</div>
            <div className="font-semibold">{p.method}</div>
          </div>
          <div>
            <div className="text-gray-500">{ar ? 'المجموع' : 'Total'}</div>
            <div className="font-bold text-fruite-green">{Number(p.totalAmount).toFixed(2)} DA</div>
          </div>
        </div>
        {p.notes && <p className="mt-3 text-sm text-gray-600">{p.notes}</p>}
      </Card>

      <Table
        headers={
          ar
            ? ['المرجع', 'تاريخ الإغلاق', 'المبلغ المدفوع', 'الباقي', 'الحالة']
            : ['Réf. bordereau', 'Date clôture', 'Montant payé', 'Reste', 'Statut']
        }
      >
        {p.lines.map((l) => (
          <tr key={l.id} className={l.statut === 'paye' ? 'bg-[#d4edda]' : l.statut === 'partiellement_paye' ? 'bg-[#fff3cd]' : ''}>
            <td className="px-4 py-3 font-semibold whitespace-nowrap">{l.bordereauRef}</td>
            <td className="px-4 py-3 whitespace-nowrap">
              {l.dateCloture ? new Date(l.dateCloture).toLocaleDateString('fr-FR') : '—'}
            </td>
            <td className="px-4 py-3 text-right whitespace-nowrap">{Number(l.montant).toFixed(2)} DA</td>
            <td className="px-4 py-3 text-right whitespace-nowrap">{Number(l.reste ?? 0).toFixed(2)} DA</td>
            <td className="px-4 py-3 whitespace-nowrap">{l.statut ?? '—'}</td>
          </tr>
        ))}
      </Table>
    </div>
  )
}
