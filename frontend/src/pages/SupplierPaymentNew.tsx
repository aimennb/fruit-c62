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
import { PageHeader, Card, Button, Input, Field, Table, Spinner, ErrorBox } from '../components/ui'
import { useLang } from '../i18n'

export default function SupplierPaymentNew() {
  const { lang } = useLang()
  const ar = lang === 'ar'
  const navigate = useNavigate()

  const [step, setStep] = useState<1 | 2>(1)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [supplierName, setSupplierName] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [eligibles, setEligibles] = useState<EligibleBordereau[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [montants, setMontants] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState<{ id: string; reference: string } | null>(null)

  useEffect(() => {
    getSuppliers()
      .then((r: any) => setSuppliers((r.items ?? r) as Supplier[]))
      .catch((e) => setError(e?.message ?? 'Erreur'))
  }, [])

  // Saisie libre : à chaque frappe on rafraîchit la liste fournisseurs et on
  // filtre les actifs dont le nom contient le texte (insensible à la casse).
  function onSupplierInput(v: string) {
    setSupplierName(v)
    setSupplierId('')
    setStep(1)
    setEligibles([])
    setShowSuggestions(true)
    getSuppliers()
      .then((r: any) => setSuppliers((r.items ?? r) as Supplier[]))
      .catch(() => {})
  }

  const suggestions = supplierName.trim()
    ? suppliers
        .filter((s: any) => s.isActive !== false)
        .filter((s) => (s.name ?? '').toLowerCase().includes(supplierName.trim().toLowerCase()))
        .slice(0, 8)
    : []

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

  async function creerBon() {
    setError('')
    setLoading(true)
    try {
      const r = await createSupplierPayment({
        supplierId,
        mode: 'PAY',
        notes: notes || null,
        lines: choisis.map((b) => ({ bordereauId: b.id, montant: montants[b.id] })),
      })
      navigate(`/paiements-fournisseur/${r.payment.id}`, {
        state: { created: true, reference: r.payment.reference },
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
            {ar
              ? 'تم إنشاء السند (في انتظار الدفع)'
              : 'Bon créé (en attente de règlement)'}{' '}
            : {success.reference}
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
        subtitle={`${ar ? 'خطوة' : 'Étape'} ${step}/2`}
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
          <div className="relative">
            <Input
              type="text"
              value={supplierName}
              placeholder={ar ? 'اكتب اسم المورد…' : 'Tapez le nom du fournisseur…'}
              onChange={(e) => onSupplierInput(e.target.value)}
              onFocus={() => setShowSuggestions(true)}
            />
            {showSuggestions && supplierName.trim() !== '' && !supplierId && (
              <div className="absolute z-20 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg max-h-60 overflow-auto">
                {suggestions.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-500">
                    {ar ? 'لا يوجد مورد' : 'Aucun fournisseur trouvé'}
                  </div>
                ) : (
                  suggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-100"
                      onClick={() => {
                        setSupplierId(s.id)
                        setSupplierName(s.name)
                        setShowSuggestions(false)
                      }}
                    >
                      {s.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
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
              <Table
                headers={['', 'Réf.', 'Bon de réception', 'Date clôture', 'Montant dû', 'Montant prévu', 'Statut']}
              >
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
                    <td className="px-4 py-3">{b.receptionRef ?? '—'}</td>
                    <td className="px-4 py-3">
                      {b.dateCloture ? new Date(b.dateCloture).toLocaleDateString('fr-FR') : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">{Number(b.montantFinalDu).toFixed(2)} DA</td>
                    <td className="px-4 py-3 text-right">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        max={b.montantFinalDu}
                        value={montants[b.id] ?? ''}
                        onChange={(e) => setMontants({ ...montants, [b.id]: e.target.value })}
                        className="max-w-[130px] text-right"
                        disabled={!selected[b.id]}
                      />
                    </td>
                    <td className="px-4 py-3">{b.statut}</td>
                  </tr>
                ))}
              </Table>
              <div className="mt-3 text-right font-bold text-lg text-fruite-green">
                Total : {total.toFixed(2)} DA
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <Field label={ar ? 'ملاحظات' : 'Observations'}>
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
              </div>
              <div className="mt-4">
                <Button disabled={loading || choisis.length === 0 || total <= 0} onClick={creerBon}>
                  {ar ? 'إنشاء السند' : 'Créer le bon'} ({choisis.length})
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

    </div>
  )
}
