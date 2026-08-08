import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  getSupplierBordereau,
  updateSupplierBordereau,
  affectAdvanceToBordereau,
  openBordereauPdf,
  getAdvances,
  clotureBordereau,
  correctBordereau,
} from '../api'
import {
  PageHeader,
  ErrorBox,
  Button,
  Input,
  Select,
  Field,
  Table,
  Spinner,
  Badge,
  Card,
  Modal,
} from '../components/ui'
import { useLang } from '../i18n'

interface VenteLine {
  id: string
  invoiceId: string
  date: string
  invoiceRef: string
  colis: string
  productName: string
  lotNumber?: string | null
  calibre?: string | null
  netWeight: string
  unitPrice: string
  montant: string
}

interface LotLine {
  id: string
  lotNumber: string
  calibre?: string | null
  quantity: string
  remainingQuantity: string
}

interface PerteLine {
  id: string
  date: string
  quantity: string
  reason: string | null
  cost: string
}

interface BordereauDetail {
  id: string
  reference: string
  colisRecus: string
  colisVendus: string
  colisRestant: string
  statut: string
  calibre?: string | null
  commissionType: string
  commissionValue: string
  avancesAffectees: string
  totalBrutVentes: string
  poidsNetTotal?: string
  commission: string
  montantFinalDu: string
  droitMarche?: string
  transport?: string
  dateCloture?: string | null
  clotureParUserId?: string | null
  commissionDefinitive?: string | null
  avancesDefinitives?: string | null
  montantFinalDefinitif?: string | null
  supplier?: { id: string; name: string }
  product?: { id: string; name: string }
  lot?: { id: string; lotNumber: string }
  reception?: { id: string; reference: string }
  lots?: LotLine[]
  ventes: VenteLine[]
  pertes?: PerteLine[]
  totalPertesColis?: string
  totalPertesCout?: string
}

function statutColor(s: string): string {
  switch (s) {
    case 'ouvert':
      return 'green'
    case 'pret_a_cloturer':
      return 'amber'
    case 'cloture':
      return 'blue'
    case 'paye':
      return 'green'
    case 'partiellement_paye':
      return 'amber'
    case 'annule':
      return 'red'
    default:
      return 'gray'
  }
}

export default function BordereauDetail() {
  const { lang } = useLang()
  const ar = lang === 'ar'
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [b, setB] = useState<BordereauDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Commission form
  const [commissionType, setCommissionType] = useState('pourcentage')
  const [commissionValue, setCommissionValue] = useState('0')

  // Avance modal
  const [advanceModal, setAdvanceModal] = useState(false)
  const [advances, setAdvances] = useState<any[]>([])
  const [selAdvance, setSelAdvance] = useState('')
  const [avanceMontant, setAvanceMontant] = useState('')

  // Clôture + correction
  const [clotureModal, setClotureModal] = useState(false)
  const [correctionModal, setCorrectionModal] = useState(false)
  const [motif, setMotif] = useState('')
  const [corrValue, setCorrValue] = useState('')
  const [corrType, setCorrType] = useState('pourcentage')

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const d = (await getSupplierBordereau(id)) as BordereauDetail
      setB(d)
      setCommissionType(d.commissionType || 'pourcentage')
      setCommissionValue(String(Number(d.commissionValue || 0)))
    } catch (e: any) {
      setError(e?.message ?? 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  async function saveCommission() {
    if (!id) return
    setSaving(true)
    setError(null)
    try {
      await updateSupplierBordereau(id, {
        commissionType: commissionType as 'pourcentage' | 'fixe',
        commissionValue: Number(commissionValue || 0),
      })
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Erreur mise à jour commission')
    } finally {
      setSaving(false)
    }
  }

  async function openAdvanceModal() {
    setAdvanceModal(true)
    try {
      const list = await getAdvances()
      const arr = Array.isArray(list) ? list : (list as any).items ?? []
      setAdvances(arr.filter((a: any) => !b?.supplier || a.supplierId === b.supplier?.id))
    } catch {
      setAdvances([])
    }
  }

  async function affectAdvance() {
    if (!id || !selAdvance) return
    setSaving(true)
    setError(null)
    try {
      await affectAdvanceToBordereau(id, { advanceId: selAdvance, amount: Number(avanceMontant || 0) })
      setAdvanceModal(false)
      setSelAdvance('')
      setAvanceMontant('')
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Erreur affectation avance')
    } finally {
      setSaving(false)
    }
  }

  async function printPdf() {
    if (!id) return
    try {
      await openBordereauPdf(id)
    } catch (e: any) {
      setError(e?.message ?? 'Erreur PDF')
    }
  }

  async function doCloture() {
    if (!id) return
    setSaving(true)
    setError(null)
    try {
      await clotureBordereau(id)
      setClotureModal(false)
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Erreur clôture')
    } finally {
      setSaving(false)
    }
  }

  async function doCorrection() {
    if (!id || !motif.trim()) return
    setSaving(true)
    setError(null)
    try {
      await correctBordereau(id, {
        motif: motif.trim(),
        commissionType: corrType,
        commissionValue: Number(corrValue || 0),
      })
      setCorrectionModal(false)
      setMotif('')
      setCorrValue('')
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Erreur correction')
    } finally {
      setSaving(false)
    }
  }

  const isCloture = b?.statut === 'cloture'

  const venteHeaders = ar
    ? ['التاريخ', 'رقم الفاتورة', 'الطرود', 'المنتج', 'المعيار', 'الوزن الصافي', 'السعر/كغ', 'المبلغ']
    : ['Date', 'N° Facture', 'Colis', 'Produit', 'Calibre', 'Poids net', 'Prix/kg', 'Montant']

  if (loading) return <Spinner label={ar ? 'جارٍ التحميل…' : 'Chargement…'} />
  if (!b) return <ErrorBox message={error ?? 'Bordereau introuvable'} />

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title={`${ar ? 'بردية' : 'Bordereau'} ${b.reference}`}
        subtitle={b.supplier?.name ?? ''}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/bordereaux')}>
              {ar ? 'رجوع' : 'Retour'}
            </Button>
            {b.statut === 'pret_a_cloturer' && (
              <Button onClick={() => setClotureModal(true)}>{ar ? 'إقفال' : 'Clôturer'}</Button>
            )}
            {isCloture && (
              <Button variant="secondary" onClick={() => { setCorrType(b.commissionType); setCorrValue(String(Number(b.commissionValue))); setCorrectionModal(true) }}>
                {ar ? 'تصحيح' : 'Correction'}
              </Button>
            )}
            <Button onClick={printPdf}>{ar ? 'طباعة' : 'Imprimer'}</Button>
          </div>
        }
      />

      {error && <ErrorBox message={error} />}

      {isCloture && (
        <Card className="p-3 bg-blue-50 border border-blue-200 text-sm text-blue-800">
          {ar ? 'أُقفلت البردية' : 'Clôturé le'}{' '}
          {b.dateCloture ? new Date(b.dateCloture).toLocaleString('fr-FR') : '—'}
          {b.clotureParUserId ? ` ${ar ? 'بواسطة' : 'par'} ${b.clotureParUserId}` : ''}
          {' — '}
          {ar ? 'غير قابل للتعديل المباشر (استخدم التصحيح)' : 'non modifiable directement (utiliser Correction)'}
        </Card>
      )}

      {/* Infos bordereau */}
      <Card className="p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-gray-400">{ar ? 'المورد' : 'Fournisseur'}</div>
            <div className="font-semibold">{b.supplier?.name ?? '—'}</div>
          </div>
          <div>
            <div className="text-gray-400">{ar ? 'المنتج' : 'Produit'}</div>
            <div className="font-semibold">{(b.product?.name ?? '—') + (b.calibre ? ' / ' + b.calibre : '')}</div>
          </div>
          <div>
            <div className="text-gray-400">{ar ? 'رقم الحصة' : 'N° Lot'}</div>
            <div className="font-semibold">{b.lot?.lotNumber ?? '—'}</div>
          </div>
          <div>
            <div className="text-gray-400">{ar ? 'الحالة' : 'Statut'}</div>
            <Badge color={statutColor(b.statut)}>{b.statut}</Badge>
          </div>
          <div>
            <div className="text-gray-400">{ar ? 'الطرود المستلمة' : 'Colis reçus'}</div>
            <div className="font-semibold">{Number(b.colisRecus)}</div>
          </div>
          <div>
            <div className="text-gray-400">{ar ? 'المباعة' : 'Colis vendus'}</div>
            <div className="font-semibold">{Number(b.colisVendus)}</div>
          </div>
          <div>
            <div className="text-gray-400">{ar ? 'المتبقية' : 'Colis restants'}</div>
            <div className="font-semibold">{Number(b.colisRestant)}</div>
          </div>
        </div>
      </Card>

      {/* Lots / calibres du bordereau (multi-calibres) */}
      {b.lots && b.lots.length > 0 && (
        <div>
          <h3 className="font-semibold text-gray-700 mb-2">{ar ? 'الحصص / المعايير' : 'Lots / Calibres'}</h3>
          <Table headers={ar ? ['رقم الحصة', 'المعيار', 'الطرود', 'المتبقي'] : ['N° Lot', 'Calibre', 'Colis', 'Restant']}>
            {b.lots.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-2 whitespace-nowrap font-medium">{l.lotNumber}</td>
                <td className="px-4 py-2 whitespace-nowrap">{l.calibre ?? '—'}</td>
                <td className="px-4 py-2 text-center">{Number(l.quantity)}</td>
                <td className="px-4 py-2 text-center">{Number(l.remainingQuantity)}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      {/* Tableau des ventes */}
      <div>
        <h3 className="font-semibold text-gray-700 mb-2">{ar ? 'جدول المبيعات' : 'Tableau des ventes'}</h3>
        <Table headers={venteHeaders}>
          {b.ventes.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                {ar ? 'لا توجد مبيعات' : 'Aucune vente pour ce lot'}
              </td>
            </tr>
          ) : (
            b.ventes.map((v) => (
              <tr
                key={v.id}
                className="cursor-pointer hover:bg-gray-50"
                onClick={() => window.open('/factures/' + v.invoiceId, '_blank')}
                title={lang === 'ar' ? 'فتح تفاصيل الفاتورة' : 'Ouvrir le détail de la facture'}
              >
                <td className="px-4 py-2 whitespace-nowrap">{new Date(v.date).toLocaleDateString('fr-FR')}</td>
                <td className="px-4 py-2 whitespace-nowrap font-medium text-fruite-green underline">{v.invoiceRef}</td>
                <td className="px-4 py-2 text-center">{Number(v.colis)}</td>
                <td className="px-4 py-2 whitespace-nowrap">{v.productName}</td>
                <td className="px-4 py-2 whitespace-nowrap">{v.calibre ?? b.calibre ?? '—'}</td>
                <td className="px-4 py-2 text-right">{Number(v.netWeight).toFixed(2)}</td>
                <td className="px-4 py-2 text-right">{Number(v.unitPrice).toFixed(2)}</td>
                <td className="px-4 py-2 text-right font-semibold">{Number(v.montant).toFixed(2)}</td>
              </tr>
            ))
          )}
          {b.ventes.length > 0 && (
            <tr className="bg-gray-50 font-semibold">
              <td colSpan={5} className="px-4 py-2">{ar ? 'إجمالي الوزن الصافي' : 'Poids net total'}</td>
              <td className="px-4 py-2 text-right">{Number(b.poidsNetTotal ?? 0).toFixed(2)}</td>
              <td colSpan={2}></td>
            </tr>
          )}
        </Table>
      </div>

      {/* Section Pertes (affichage seul — n'affecte pas les calculs) */}
      <div>
        <h3 className="font-semibold text-gray-700 mb-2">{ar ? 'خسارة' : 'Pertes'}</h3>
        <Table headers={ar ? ['التاريخ', 'الطرود', 'السبب', 'التكلفة'] : ['Date', 'Colis', 'Raison', 'Coût']}>
          {!b.pertes || b.pertes.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-gray-400">
                {ar ? 'لا توجد خسارة' : 'Aucune perte'}
              </td>
            </tr>
          ) : (
            <>
              {b.pertes.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2 whitespace-nowrap">{new Date(p.date).toLocaleDateString('fr-FR')}</td>
                  <td className="px-4 py-2 text-center">{Number(p.quantity)}</td>
                  <td className="px-4 py-2">{p.reason ?? '—'}</td>
                  <td className="px-4 py-2 text-right font-semibold text-red-600">{Number(p.cost).toFixed(2)} DA</td>
                </tr>
              ))}
              <tr className="bg-gray-50 font-semibold">
                <td className="px-4 py-2">{ar ? 'المجموع' : 'Total'}</td>
                <td className="px-4 py-2 text-center">{Number(b.totalPertesColis ?? 0)}</td>
                <td className="px-4 py-2"></td>
                <td className="px-4 py-2 text-right text-red-600">{Number(b.totalPertesCout ?? 0).toFixed(2)} DA</td>
              </tr>
            </>
          )}
        </Table>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <h3 className="font-semibold text-gray-700">{ar ? 'العمولة' : 'Commission'}</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label={ar ? 'النوع' : 'Type'}>
              <Select value={commissionType} onChange={(e) => setCommissionType(e.target.value)}>
                <option value="pourcentage">{ar ? 'نسبة مئوية %' : 'Pourcentage %'}</option>
                <option value="fixe">{ar ? 'مبلغ ثابت' : 'Montant fixe'}</option>
                <option value="poids">{ar ? 'بالوزن (دج/كغ)' : 'Prix/kg net (DA/kg)'}</option>
              </Select>
            </Field>
            <Field label={commissionType === 'fixe' ? (ar ? 'المبلغ (دج)' : 'Montant (DA)') : commissionType === 'poids' ? (ar ? 'السعر/كغ (دج)' : 'Prix/kg (DA)') : (ar ? 'النسبة (%)' : 'Taux (%)')}>
              <Input type="number" min="0" step="0.01" value={commissionValue} disabled={isCloture} onChange={(e) => setCommissionValue(e.target.value)} />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button onClick={saveCommission} disabled={saving || isCloture}>
              {saving ? '…' : ar ? 'حفظ العمولة' : 'Enregistrer commission'}
            </Button>
            <Button variant="secondary" onClick={openAdvanceModal} disabled={isCloture}>
              {ar ? '+ إضافة سلفة' : '+ Affecter une avance'}
            </Button>
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="font-semibold text-gray-700 mb-3">{ar ? 'الحسابات' : 'Calculs'}</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">{ar ? 'إجمالي المبيعات' : 'Total brut ventes'}</span>
              <span className="font-semibold">{Number(b.totalBrutVentes).toFixed(2)} DA</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">
                {ar ? 'العمولة' : 'Commission'} ({b.commissionType === 'fixe' ? `${Number(b.commissionValue).toFixed(2)} DA` : `${Number(b.commissionValue).toFixed(2)} %`})
              </span>
              <span className="font-semibold text-red-600">- {Number(b.commission).toFixed(2)} DA</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{ar ? 'السلف المخصصة' : 'Avances affectées'}</span>
              <span className="font-semibold text-red-600">- {Number(b.avancesAffectees).toFixed(2)} DA</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{ar ? 'حق السوق' : 'Droit de marché'}</span>
              <span className="font-semibold text-red-600">- {Number(b.droitMarche ?? 0).toFixed(2)} DA</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{ar ? 'النقل' : 'Transport'}</span>
              <span className="font-semibold text-red-600">- {Number(b.transport ?? 0).toFixed(2)} DA</span>
            </div>
            <div className="flex justify-between border-t pt-2 mt-2 text-base">
              <span className="font-bold">{ar ? 'المبلغ النهائي المستحق' : 'Montant final dû'}</span>
              <span className="font-bold text-fruite-green">{Number(b.montantFinalDu).toFixed(2)} DA</span>
            </div>
          </div>
        </Card>
      </div>

      <Modal
        open={advanceModal}
        title={ar ? 'تخصيص سلفة للبردية' : 'Affecter une avance'}
        onClose={() => setAdvanceModal(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdvanceModal(false)}>
              {ar ? 'إلغاء' : 'Annuler'}
            </Button>
            <Button onClick={affectAdvance} disabled={saving || !selAdvance}>
              {saving ? '…' : ar ? 'تخصيص' : 'Affecter'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={ar ? 'السلفة' : 'Avance'}>
            <Select value={selAdvance} onChange={(e) => setSelAdvance(e.target.value)}>
              <option value="">{ar ? '— اختر —' : '— Choisir —'}</option>
              {advances.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.reference} — {Number(a.amount).toFixed(2)} DA
                </option>
              ))}
            </Select>
          </Field>
          <Field label={ar ? 'المبلغ المخصص (دج)' : 'Montant à affecter (DA)'}>
            <Input type="number" min="0" step="0.01" value={avanceMontant} onChange={(e) => setAvanceMontant(e.target.value)} />
          </Field>
        </div>
      </Modal>

      {/* Modal confirmation clôture */}
      <Modal
        open={clotureModal}
        title={ar ? 'تأكيد الإقفال' : 'Confirmer la clôture'}
        onClose={() => setClotureModal(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setClotureModal(false)}>
              {ar ? 'إلغاء' : 'Annuler'}
            </Button>
            <Button onClick={doCloture} disabled={saving}>
              {saving ? '…' : ar ? 'إقفال' : 'Clôturer'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-gray-600">
          {ar
            ? `هل تريد إقفال البردية ${b?.reference} ؟ سيتم تجميد الحسابات النهائية.`
            : `Confirmer la clôture du bordereau ${b?.reference} ? Les totaux définitifs seront figés.`}
        </p>
      </Modal>

      {/* Modal correction (bordereau clôturé) */}
      <Modal
        open={correctionModal}
        title={ar ? 'عملية تصحيحية' : 'Opération corrective'}
        onClose={() => setCorrectionModal(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCorrectionModal(false)}>
              {ar ? 'إلغاء' : 'Annuler'}
            </Button>
            <Button onClick={doCorrection} disabled={saving || !motif.trim()}>
              {saving ? '…' : ar ? 'تطبيق التصحيح' : 'Appliquer la correction'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={ar ? 'السبب (إلزامي)' : 'Motif (obligatoire)'}>
            <Input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder={ar ? 'سبب التصحيح' : 'Motif de la correction'} />
          </Field>
          <Field label={ar ? 'النوع' : 'Type'}>
            <Select value={corrType} onChange={(e) => setCorrType(e.target.value)}>
              <option value="pourcentage">{ar ? 'نسبة مئوية %' : 'Pourcentage %'}</option>
              <option value="fixe">{ar ? 'مبلغ ثابت' : 'Montant fixe'}</option>
            </Select>
          </Field>
          <Field label={corrType === 'fixe' ? (ar ? 'المبلغ (دج)' : 'Montant (DA)') : (ar ? 'النسبة (%)' : 'Taux (%)')}>
            <Input type="number" min="0" step="0.01" value={corrValue} onChange={(e) => setCorrValue(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
