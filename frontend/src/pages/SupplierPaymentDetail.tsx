import { useEffect, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import {
  getSupplierPayment,
  openSupplierPaymentPdf,
  paySupplierPayment,
  type SupplierPaymentDetailDTO,
} from '../api'
import {
  PageHeader,
  Card,
  Button,
  Table,
  Spinner,
  ErrorBox,
  Badge,
  Modal,
  Field,
  Input,
  Select,
} from '../components/ui'
import { useLang } from '../i18n'

type Methode = 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD'

export default function SupplierPaymentDetail() {
  const { id } = useParams<{ id: string }>()
  const { lang } = useLang()
  const ar = lang === 'ar'
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [p, setP] = useState<SupplierPaymentDetailDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // --- Règlement (partiel multiple) ---
  const [modeReglement, setModeReglement] = useState<'PAY' | 'ENCAISSER' | null>(null)
  const [method, setMethod] = useState<Methode>('CASH')
  const [montants, setMontants] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [payError, setPayError] = useState('')

  function charger(pid: string) {
    return getSupplierPayment(pid)
      .then((d) => {
        setP(d)
        return d
      })
      .catch((e) => {
        setError(e?.message ?? 'Erreur')
        return null
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!id) return
    charger(id).then((d) => {
      const q = searchParams.get('regler')
      if (d && (q === 'PAY' || q === 'ENCAISSER') && d.status !== 'paye') ouvrirReglement(q, d)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Lignes encore réglables (bordereau non soldé).
  function payables(d: SupplierPaymentDetailDTO) {
    return d.lines.filter((l) => l.statut !== 'paye' && Number(l.reste ?? 0) > 0)
  }

  function ouvrirReglement(mode: 'PAY' | 'ENCAISSER', d?: SupplierPaymentDetailDTO | null) {
    const src = d ?? p
    if (!src) return
    const m: Record<string, string> = {}
    for (const l of payables(src)) m[l.bordereauId] = Number(l.reste ?? 0).toFixed(2)
    setMontants(m)
    setPayError('')
    setModeReglement(mode)
  }

  async function confirmerReglement() {
    if (!p || !id || !modeReglement) return
    const lines = Object.entries(montants)
      .filter(([, v]) => Number(v) > 0)
      .map(([bordereauId, montant]) => ({ bordereauId, montant }))
    if (lines.length === 0) {
      setPayError(ar ? 'أدخل مبلغا' : 'Saisissez au moins un montant')
      return
    }
    setSaving(true)
    setPayError('')
    try {
      await paySupplierPayment(id, {
        mode: modeReglement,
        method: modeReglement === 'PAY' ? method : undefined,
        lines,
      })
      setModeReglement(null)
      await charger(id)
    } catch (e: any) {
      setPayError(e?.message ?? 'Erreur règlement')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner label={ar ? 'جاري التحميل' : 'Chargement...'} />
  if (error) return <ErrorBox message={error} />
  if (!p) return null

  const statusLabel =
    p.status === 'paye'
      ? ar
        ? 'مدفوع'
        : 'Payé'
      : p.status === 'partiellement_paye'
        ? ar
          ? 'مدفوع جزئيا'
          : 'Partiellement payé'
        : ar
          ? 'في الانتظار'
          : 'En attente'

  const listePayables = payables(p)
  const totalSaisi = Object.values(montants).reduce((s, v) => s + (Number(v) || 0), 0)

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

      {/* Boutons de règlement (masqués si le bon est soldé) */}
      {p.status !== 'paye' && (
        <div className="mb-4 flex gap-2">
          <Button disabled={listePayables.length === 0} onClick={() => ouvrirReglement('PAY')}>
            {ar ? 'دفع' : 'Payer'}
          </Button>
          <Button
            variant="secondary"
            disabled={listePayables.length === 0}
            onClick={() => ouvrirReglement('ENCAISSER')}
          >
            {ar ? 'دفع مؤجل' : 'Paiement différé'}
          </Button>
        </div>
      )}
      {p.status !== 'paye' && (
        <p className="mb-4 text-xs text-gray-500">
          {ar
            ? 'الدفع المؤجل: تسديد المبلغ المستحق على عدة دفعات.'
            : 'Règlement en plusieurs fois du montant dû'}
        </p>
      )}

      <Card className="mb-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
          <div>
            <div className="text-gray-500">{ar ? 'التاريخ' : 'Date'}</div>
            <div className="font-semibold">{new Date(p.date).toLocaleDateString('fr-FR')}</div>
          </div>
          <div>
            <div className="text-gray-500">Mode</div>
            <Badge color={p.mode === 'PAY' ? 'blue' : 'amber'}>
              {p.mode === 'PAY' ? 'Payer' : 'Paiement différé'}
            </Badge>
            {p.mode !== 'PAY' && (
              <div className="mt-1 text-xs text-gray-500">
                {ar
                  ? 'خصم من سلفة مدفوعة مسبقاً (لا يخرج من الصندوق).'
                  : 'Impute une avance déjà encaissée auprès du fournisseur (ne sort pas de caisse).'}
              </div>
            )}
          </div>
          <div>
            <div className="text-gray-500">{ar ? 'الطريقة' : 'Méthode'}</div>
            <div className="font-semibold">{p.method}</div>
          </div>
          <div>
            <div className="text-gray-500">{ar ? 'الحالة' : 'Statut'}</div>
            <Badge
              color={p.status === 'paye' ? 'green' : p.status === 'partiellement_paye' ? 'amber' : 'gray'}
            >
              {statusLabel}
            </Badge>
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
            ? ['المرجع', 'سند الاستلام', 'المنتج', 'تاريخ الإغلاق', 'المبلغ المدفوع', 'الباقي', 'الحالة']
            : [
                'Réf. bordereau',
                'Bon de réception',
                'Produit',
                'Date clôture',
                'Montant payé',
                'Reste',
                'Statut',
              ]
        }
      >
        {p.lines.map((l) => (
          <tr key={l.id} className={l.statut === 'paye' ? 'bg-[#d4edda]' : l.statut === 'partiellement_paye' ? 'bg-[#fff3cd]' : ''}>
            <td className="px-4 py-3 font-semibold whitespace-nowrap">{l.bordereauRef}</td>
            <td className="px-4 py-3 whitespace-nowrap">{l.receptionRef ?? '—'}</td>
            <td className="px-4 py-3 whitespace-nowrap">{l.productName ?? '—'}</td>
            <td className="px-4 py-3 whitespace-nowrap">
              {l.dateCloture ? new Date(l.dateCloture).toLocaleDateString('fr-FR') : '—'}
            </td>
            <td className="px-4 py-3 text-right whitespace-nowrap">{Number(l.montantPaye ?? 0).toFixed(2)} DA</td>
            <td className="px-4 py-3 text-right whitespace-nowrap">{Number(l.reste ?? 0).toFixed(2)} DA</td>
            <td className="px-4 py-3 whitespace-nowrap">{l.statut ?? '—'}</td>
          </tr>
        ))}
      </Table>

      {modeReglement && (
        <Modal
          open
          onClose={() => setModeReglement(null)}
          title={
            modeReglement === 'PAY'
              ? ar
                ? 'دفع'
                : 'Payer'
              : ar
                ? 'دفع مؤجل'
                : 'Paiement différé'
          }
        >
          {payError && <ErrorBox message={payError} />}
          <Table headers={ar ? ['المرجع', 'الباقي', 'المبلغ'] : ['Réf. bordereau', 'Reste dû', 'Montant']}>
            {listePayables.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-3 font-semibold whitespace-nowrap">{l.bordereauRef}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {Number(l.reste ?? 0).toFixed(2)} DA
                </td>
                <td className="px-4 py-3 text-right">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max={Number(l.reste ?? 0)}
                    value={montants[l.bordereauId] ?? ''}
                    onChange={(e) => setMontants({ ...montants, [l.bordereauId]: e.target.value })}
                    className="max-w-[140px] text-right"
                  />
                </td>
              </tr>
            ))}
          </Table>
          {modeReglement === 'PAY' && (
            <div className="mt-3">
              <Field label={ar ? 'طريقة الدفع' : 'Méthode'}>
                <Select value={method} onChange={(e) => setMethod(e.target.value as Methode)}>
                  <option value="CASH">Espèces</option>
                  <option value="BANK_TRANSFER">Virement</option>
                  <option value="CHECK">Chèque</option>
                  <option value="CARD">Carte</option>
                </Select>
              </Field>
            </div>
          )}
          <div className="mt-3 text-right font-bold text-fruite-green">
            Total : {totalSaisi.toFixed(2)} DA
          </div>
          <div className="mt-4 flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setModeReglement(null)}>
              {ar ? 'إلغاء' : 'Annuler'}
            </Button>
            <Button disabled={saving || totalSaisi <= 0} onClick={confirmerReglement}>
              {ar ? 'تأكيد' : 'Confirmer'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
