import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getSuppliers,
  getEligibleBordereaux,
  createSupplierPayment,
  openSupplierPaymentPdf,
  type EligibleBordereau,
} from '../api'
import type { Supplier } from '../types'
import { PageHeader, Card, Button, Select, Input, Field, Table, Spinner, ErrorBox } from '../components/ui'
import { useLang } from '../i18n'

type Methode = 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD'

export default function SupplierPaymentNew() {
  const { lang } = useLang()
  const ar = lang === 'ar'
  const navigate = useNavigate()

  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [eligibles, setEligibles] = useState<EligibleBordereau[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [montants, setMontants] = useState<Record<string, string>>({})
  const [method, setMethod] = useState<Methode>('CASH')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState<{ id: string; reference: string } | null>(null)

  useEffect(() => {
    getSuppliers()
      .then((r: any) => setSuppliers((r.items ?? r) as Supplier[]))
      .catch((e) => setError(e?.message ?? 'Erreur'))
  }, [])

  async function chargerEligibles() {
    if (!supplierId) return
    setLoading(true)
    setError('')
    try {
      const r = await getEligibleBordereaux(supplierId)
      setEligibles(r.items ?? [])
      const m: Record<string, string> = {}
      for (const b of r.items ?? []) m[b.id] = Number(b.montantFinalDu).toFixed(2)
      setMontants(m)
      setSelected({})
      setStep(2)
    } catch (e: any) {
      setError(e?.message ?? 'Erreur')
    } finally {
      setLoading(false)
    }
  }

  const choisis = eligibles.filter((b) => selected[b.id])
  const total = choisis.reduce((s, b) => s + (Number(montants[b.id]) || 0), 0)

  async function soumettre(mode: 'PAY' | 'ENCAISSER') {
    setError('')
    setLoading(true)
    try {
      const r = await createSupplierPayment({
        supplierId,
        mode,
        method: mode === 'PAY' ? method : undefined,
        notes: notes || null,
        lines: choisis.map((b) => ({ bordereauId: b.id, montant: montants[b.id] })),
      })
      setSuccess({ id: r.payment.id, reference: r.payment.reference })
    } catch (e: any) {
      setError(e?.message ?? 'Erreur création')
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div>
        <PageHeader title={ar ? 'تم الدفع' : 'Paiement enregistré'} />
        <Card>
          <p className="text-lg font-semibold text-fruite-green mb-4">
            {ar ? 'تم إنشاء السند' : 'Bon de paiement créé'} : {success.reference}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => openSupplierPaymentPdf(success.id)}>PDF</Button>
            <Button variant="secondary" onClick={() => navigate(`/paiements-fournisseur/${success.id}`)}>
              {ar ? 'التفاصيل' : 'Détail'}
            </Button>
            <Button variant="ghost" onClick={() => navigate('/paiements-fournisseur')}>
              {ar ? 'القائمة' : 'Liste'}
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={ar ? 'سند دفع مورد جديد' : 'Nouveau bon de paiement fournisseur'}
        subtitle={`${ar ? 'خطوة' : 'Étape'} ${step}/3`}
        actions={
          <Button variant="secondary" onClick={() => navigate('/paiements-fournisseur')}>
            {ar ? 'رجوع' : 'Retour'}
          </Button>
        }
      />
      {error && <ErrorBox message={error} />}

      {/* Étape 1 : fournisseur */}
      <Card className="mb-4">
        <Field label={ar ? 'المورد' : 'Fournisseur'}>
          <Select
            value={supplierId}
            onChange={(e) => {
              setSupplierId(e.target.value)
              setStep(1)
              setEligibles([])
            }}
          >
            <option value="">{ar ? '— اختر —' : '— Choisir —'}</option>
            {suppliers
              .filter((s: any) => s.isActive !== false)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </Select>
        </Field>
        <div className="mt-3">
          <Button disabled={!supplierId || loading} onClick={chargerEligibles}>
            {ar ? 'عرض البرديات' : 'Voir les bordereaux clôturés'}
          </Button>
        </div>
      </Card>

      {loading && <Spinner />}

      {/* Étape 2 : sélection des bordereaux */}
      {step >= 2 && (
        <Card className="mb-4">
          <h2 className="font-semibold mb-3">
            {ar ? 'البرديات القابلة للدفع' : 'Bordereaux clôturés à payer'}
          </h2>
          {eligibles.length === 0 ? (
            <p className="text-sm text-gray-500">
              {ar ? 'لا توجد بردية قابلة للدفع' : 'Aucun bordereau éligible pour ce fournisseur'}
            </p>
          ) : (
            <>
              <Table headers={['', 'Réf.', 'Date clôture', 'Montant dû', 'Statut']}>
                {eligibles.map((b) => (
                  <tr
                    key={b.id}
                    className={b.statut === 'partiellement_paye' ? 'bg-[#fff3cd]' : ''}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={!!selected[b.id]}
                        onChange={(e) => setSelected({ ...selected, [b.id]: e.target.checked })}
                      />
                    </td>
                    <td className="px-4 py-3 font-semibold">{b.reference}</td>
                    <td className="px-4 py-3">
                      {b.dateCloture ? new Date(b.dateCloture).toLocaleDateString('fr-FR') : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">{Number(b.montantFinalDu).toFixed(2)} DA</td>
                    <td className="px-4 py-3">{b.statut}</td>
                  </tr>
                ))}
              </Table>
              <div className="mt-3">
                <Button disabled={choisis.length === 0} onClick={() => setStep(3)}>
                  {ar ? 'التالي' : 'Continuer'} ({choisis.length})
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

      {/* Étape 3 : montants + validation */}
      {step === 3 && choisis.length > 0 && (
        <Card>
          <h2 className="font-semibold mb-3">{ar ? 'المبالغ' : 'Montants à régler'}</h2>
          <Table headers={['Réf.', 'Montant dû', 'Montant à payer']}>
            {choisis.map((b) => (
              <tr key={b.id}>
                <td className="px-4 py-3 font-semibold">{b.reference}</td>
                <td className="px-4 py-3 text-right">{Number(b.montantFinalDu).toFixed(2)} DA</td>
                <td className="px-4 py-3 text-right">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max={b.montantFinalDu}
                    value={montants[b.id] ?? ''}
                    onChange={(e) => setMontants({ ...montants, [b.id]: e.target.value })}
                    className="max-w-[140px] text-right"
                  />
                </td>
              </tr>
            ))}
          </Table>
          <div className="mt-3 text-right font-bold text-lg text-fruite-green">
            Total : {total.toFixed(2)} DA
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Field label={ar ? 'طريقة الدفع' : 'Méthode (pour Payer)'}>
              <Select value={method} onChange={(e) => setMethod(e.target.value as Methode)}>
                <option value="CASH">Espèces</option>
                <option value="BANK_TRANSFER">Virement</option>
                <option value="CHECK">Chèque</option>
                <option value="CARD">Carte</option>
              </Select>
            </Field>
            <Field label={ar ? 'ملاحظات' : 'Observations'}>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>

          <div className="mt-4 flex gap-2">
            <Button disabled={loading || total <= 0} onClick={() => soumettre('PAY')}>
              {ar ? 'دفع' : 'Payer'}
            </Button>
            <Button
              variant="secondary"
              disabled={loading || total <= 0}
              onClick={() => soumettre('ENCAISSER')}
            >
              {ar ? 'تحصيل من السلفة' : 'Encaisser (avance)'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}
