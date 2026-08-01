import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getProductSearch,
  getCustomerSearch,
  getFifoLot,
  getStockLots,
  createSale,
  confirmSale,
  createInvoice,
  issueInvoice,
  updateInvoice,
  createPayment,
  getInvoice,
  getSuppliers,
  type ProductSearchItem,
  type CustomerSearchItem,
  type FifoLot,
} from '../api'
import type { SaleItem } from '../types'
import {
  PageHeader,
  ErrorBox,
  Button,
  Input,
  Field,
  SearchSelect,
  type SearchSelectOption,
} from '../components/ui'
import { useLang } from '../i18n'

const da = (n: string | number | null | undefined) =>
  `${Number(n || 0).toLocaleString('fr-FR')} DA`

type Line = SaleItem & {
  name?: string
  // FOURNISSEUR PAR LIGNE (Option A) : chaque ligne porte SON fournisseur.
  supplierId?: string
  supplierName?: string
  // Lot FIFO résolu côté back (fournisseur+produit) — lecture seule (badge/alerte).
  fifoLot?: FifoLot | null
  // CALIBRE choisi (restreint le lot FIFO au calibre) — '' = tous calibres.
  caliber?: string
}

const newLine = (): Line => ({
  productId: '',
  lotId: '',
  name: '',
  supplierId: '',
  supplierName: '',
  colis: '',
  grossWeight: '',
  tare: '',
  netWeight: '',
  unitPrice: 0,
  packingUnitPrice: '',
  fifoLot: null,
  caliber: '',
})

// ---- Editable line row (AR/FR product autocomplete, fournisseur PAR LIGNE) ----
function LineRow({
  line,
  suppliers,
  canRemove,
  onChange,
  onRemove,
}: {
  line: Line
  suppliers: { id: string; name: string; nameAr?: string | null }[]
  canRemove: boolean
  onChange: (patch: Partial<Line>) => void
  onRemove: () => void
}) {
  const { lang } = useLang()
  const [results, setResults] = useState<ProductSearchItem[]>([])
  const [loading, setLoading] = useState(false)
  const reqRef = useRef(0)
  const [fifoLoading, setFifoLoading] = useState(false)
  const [supplierResults, setSupplierResults] = useState<
    { id: string; name: string; nameAr?: string | null }[]
  >([])
  const supplierId = line.supplierId ?? ''
  const caliber = line.caliber ?? ''
  // Calibres disponibles pour ce fournisseur+produit (lots restants > 0).
  const [calibres, setCalibres] = useState<string[]>([])

  // Charge les calibres distincts disponibles (fournisseur+produit).
  useEffect(() => {
    let cancelled = false
    if (!line.productId || !supplierId) {
      setCalibres([])
      return
    }
    getStockLots(line.productId)
      .then((r) => {
        if (cancelled) return
        const set = new Set<string>()
        for (const l of r.items) {
          if (l.supplierId === supplierId && l.caliber && String(l.caliber).trim()) {
            set.add(String(l.caliber).trim())
          }
        }
        setCalibres(Array.from(set).sort())
      })
      .catch(() => {
        if (!cancelled) setCalibres([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.productId, supplierId])

  // Résout le lot FIFO (fournisseur + produit + calibre) côté back. Le lot manuel a été
  // retiré : le lot est CALCULÉ automatiquement. On l'affiche en lecture seule
  // (badge) et on s'en sert pour l'alerte stock insuffisant.
  useEffect(() => {
    let cancelled = false
    if (!line.productId || !supplierId) {
      onChange({ fifoLot: null })
      return
    }
    setFifoLoading(true)
    getFifoLot(supplierId, line.productId, caliber || undefined)
      .then((r) => {
        if (cancelled) return
        onChange({ fifoLot: r.lot ?? null })
      })
      .catch(() => {
        if (!cancelled) onChange({ fifoLot: null })
      })
      .finally(() => {
        if (!cancelled) setFifoLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.productId, supplierId, caliber])

  async function query(q: string) {
    const my = reqRef.current + 1
    reqRef.current = my
    setLoading(true)
    try {
      // Recherche FILTRÉE par le fournisseur DE LA LIGNE : seuls les produits
      // de ce fournisseur AVEC lot en stock sont proposés (sans lot = masqué).
      const r = await getProductSearch(q, supplierId || undefined)
      if (reqRef.current === my) setResults(supplierId ? r.items : [])
    } catch {
      /* ignore */
    } finally {
      if (reqRef.current === my) setLoading(false)
    }
  }

  function querySupplier(q: string) {
    const needle = q.trim().toLowerCase()
    setSupplierResults(
      needle
        ? suppliers.filter(
            (s) =>
              (s.name ?? '').toLowerCase().includes(needle) ||
              (s.nameAr ?? '').toLowerCase().includes(needle),
          )
        : suppliers,
    )
  }

  const supplierOptions: SearchSelectOption[] = supplierResults.map((s) => ({
    id: s.id,
    label: s.name,
    sublabel: s.nameAr ?? null,
  }))

  const options: SearchSelectOption[] = results.map((p) => ({
    id: p.id,
    label: p.name,
    sublabel: p.nameAr ?? null,
  }))

  const productTotal = Number(line.netWeight || 0) * Number(line.unitPrice || 0)
  const packingCost = Number(line.packingUnitPrice || 0) * Number(line.colis || 0)
  const lineTotal = productTotal + packingCost

  function onBrutOrTare(next: Partial<Line>) {
    const brut = Number((next.grossWeight ?? line.grossWeight) || 0)
    const tare = Number((next.tare ?? line.tare) || 0)
    const colis = Number((next.colis ?? line.colis) || 0)
    // Le Net = Brut − (Tare × Colis), toujours recalculé automatiquement (readonly).
    const computed = brut - tare * colis
    onChange({ ...next, netWeight: computed })
  }

  // Alerte stock : la quantité (colis) demandée dépasse le lot FIFO dispo.
  const remaining = line.fifoLot ? Number(line.fifoLot.remainingQuantity) : null
  const colisNum = Number(line.colis || 0)
  const overStock = line.productId && supplierId && remaining != null && colisNum > remaining

  return (
    <tr className="align-top">
      <td className="px-2 py-2 min-w-[260px]">
        {/* FOURNISSEUR PAR LIGNE (Option A) */}
        <SearchSelect
          placeholder={lang === 'ar' ? 'ابحث عن مورد…' : 'Rechercher fournisseur…'}
          value={line.supplierName ?? ''}
          options={supplierOptions}
          loading={false}
          onQuery={querySupplier}
          onSelect={(o) =>
            onChange({
              supplierId: o.id,
              supplierName: o.label,
              // Changement de fournisseur => reset produit + lot
              productId: '',
              name: '',
              fifoLot: null,
              caliber: '',
            })
          }
          onClear={() =>
            onChange({ supplierId: '', supplierName: '', productId: '', name: '', fifoLot: null, caliber: '' })
          }
        />
      </td>
      <td className="px-2 py-2 min-w-[360px]">
        <SearchSelect
          placeholder={
            supplierId
              ? lang === 'ar'
                ? 'ابحث عن منتج…'
                : 'Rechercher produit…'
              : lang === 'ar'
                ? 'اختر موردًا أولاً'
                : "Choisir d'abord un fournisseur"
          }
          value={(line.name ?? '') + (line.caliber ? ' - calb:' + line.caliber : '')}
          options={options}
          loading={loading}
          onQuery={query}
          onSelect={(o) => onChange({ productId: o.id, name: o.label, fifoLot: null, caliber: '' })}
          onClear={() => onChange({ productId: '', name: '', fifoLot: null, caliber: '' })}
        />
        {/* SELECT CALIBRE : restreint le lot FIFO au calibre choisi */}
        {line.productId && supplierId && calibres.length > 0 && (
          <div className="mt-1 flex items-center gap-1">
            <label className="text-[11px] text-gray-500">
              {lang === 'ar' ? 'المعيار' : 'Calibre'}
            </label>
            <select
              className="border rounded px-1.5 py-0.5 text-[12px] bg-white"
              value={caliber}
              onChange={(e) => onChange({ caliber: e.target.value, fifoLot: null })}
            >
              <option value="">—</option>
              {calibres.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        )}
        {/* Badge lot FIFO résolu (lecture seule) + alerte stock */}
        {line.productId && supplierId && (
          <div className="mt-1 text-[11px] leading-tight">
            {fifoLoading ? (
              <span className="text-gray-400">
                {lang === 'ar' ? 'جارٍ حساب الدفعة…' : 'Résolution du lot…'}
              </span>
            ) : line.fifoLot ? (
              <span className="inline-block rounded bg-fruite-green/10 text-fruite-green px-1.5 py-0.5">
                {lang === 'ar'
                  ? `دفعة تلقائية: ${line.fifoLot.lotNumber} (المتبقي ${remaining})`
                  : `Lot auto: ${line.fifoLot.lotNumber} (reste ${remaining})`}
              </span>
            ) : (
              <span className="inline-block rounded bg-red-50 text-red-600 px-1.5 py-0.5">
                {lang === 'ar'
                  ? 'لا توجد دفعة متاحة لهذا المورد/المنتج'
                  : 'Aucun lot dispo pour ce fournisseur/produit'}
              </span>
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-2 w-32">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={line.colis ?? ''}
          onChange={(e) => onBrutOrTare({ colis: e.target.value })}
        />
        {/* ALERTE STOCK INSUFFISANT (bloquante) */}
        {overStock && line.fifoLot && (
          <div className="mt-1 text-[11px] leading-tight text-red-600 font-medium">
            {lang === 'ar'
              ? `المخزون غير كافٍ: بقي ${remaining} صندوق في الدفعة ${line.fifoLot.lotNumber}`
              : `Stock insuffisant : il reste ${remaining} colis sur le lot ${line.fifoLot.lotNumber}`}
          </div>
        )}
      </td>
      <td className="px-3 py-2 w-36">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={line.grossWeight ?? ''}
          onChange={(e) => onBrutOrTare({ grossWeight: e.target.value })}
        />
      </td>
      <td className="px-3 py-2 w-36">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={line.tare ?? ''}
          onChange={(e) => onBrutOrTare({ tare: e.target.value })}
        />
      </td>
      <td className="px-3 py-2 w-36">
        <Input type="number" min="0" step="0.01" value={line.netWeight ?? ''} disabled readOnly />
      </td>
      <td className="px-3 py-2 w-40">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={line.unitPrice}
          onChange={(e) => onChange({ unitPrice: e.target.value })}
        />
      </td>
      <td className="px-3 py-2 w-40">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={line.packingUnitPrice ?? ''}
          onChange={(e) => onChange({ packingUnitPrice: e.target.value })}
        />
      </td>
      <td className="px-2 py-2 text-end text-gray-600 whitespace-nowrap">{da(packingCost)}</td>
      <td className="px-2 py-2 text-end font-semibold text-fruite-green whitespace-nowrap">
        {da(lineTotal)}
      </td>
      <td className="px-2 py-2 w-10 text-center">
        <Button
          type="button"
          variant="ghost"
          className="text-red-600"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Supprimer la ligne"
        >
          ×
        </Button>
      </td>
    </tr>
  )
}

export default function SaleNew() {
  const { lang, tr } = useLang()
  const navigate = useNavigate()

  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [createdSaleId, setCreatedSaleId] = useState<string | null>(null)
  const [createdInvoiceId, setCreatedInvoiceId] = useState<string | null>(null)

  const [customerId, setCustomerId] = useState('')
  const [customerName, setCustomerName] = useState('')
  // FOURNISSEUR PAR LIGNE (Option A) : plus de fournisseur GLOBAL — la liste
  // des fournisseurs est chargée ici et passée à chaque LineRow.
  const [suppliers, setSuppliers] = useState<{ id: string; name: string; nameAr?: string | null }[]>([])

  useEffect(() => {
    getSuppliers()
      .then((r: any) => setSuppliers(Array.isArray(r) ? r : (r?.items ?? [])))
      .catch(() => {})
  }, [])

  const [custResults, setCustResults] = useState<CustomerSearchItem[]>([])
  const [custLoading, setCustLoading] = useState(false)
  const custReqRef = useRef(0)
  const [lines, setLines] = useState<Line[]>([newLine()])

  function setLine(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function addLine() {
    setLines((prev) => [...prev, newLine()])
  }
  function removeLine(i: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))
  }

  async function queryCustomer(q: string) {
    const my = custReqRef.current + 1
    custReqRef.current = my
    setCustLoading(true)
    try {
      const r = await getCustomerSearch(q)
      if (custReqRef.current === my) setCustResults(r.items)
    } catch {
      /* ignore */
    } finally {
      if (custReqRef.current === my) setCustLoading(false)
    }
  }

  const custOptions: SearchSelectOption[] = custResults.map((c) => ({
    id: c.id,
    label: c.name,
    sublabel: c.nameAr ?? null,
  }))

  const productSubtotal = lines.reduce(
    (sum, l) => sum + Number(l.netWeight || 0) * Number(l.unitPrice || 0),
    0,
  )
  const packingSubtotal = lines.reduce(
    (sum, l) => sum + Number(l.packingUnitPrice || 0) * Number(l.colis || 0),
    0,
  )
  const total = productSubtotal + packingSubtotal

  async function saveNew(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const usedLines = lines.filter((l) => l.productId)
      if (usedLines.length === 0) throw new Error('Ajoutez au moins un article')

      // BLOCAGE : chaque ligne doit avoir SON fournisseur (Option A) + un lot
      // FIFO dispo, et la quantité (colis) ne doit pas dépasser le restant.
      for (const l of usedLines) {
        if (!l.supplierId) {
          setError(
            lang === 'ar'
              ? `يرجى اختيار مورد للسطر (${l.name ?? ''})`
              : `Veuillez sélectionner un fournisseur pour la ligne (${l.name ?? ''})`,
          )
          setSaving(false)
          return
        }
        const remaining = l.fifoLot ? Number(l.fifoLot.remainingQuantity) : null
        if (remaining == null || !l.fifoLot) {
          setError(
            lang === 'ar'
              ? `لا توجد دفعة متاحة لهذا المورد/المنتج (${l.name ?? ''})`
              : `Aucun lot disponible pour ce fournisseur/produit (${l.name ?? ''})`,
          )
          setSaving(false)
          return
        }
        const colisNum = Number(l.colis || 0)
        if (colisNum > remaining) {
          setError(
            lang === 'ar'
              ? `المخزون غير كافٍ: بقي ${remaining} صندوق في الدفعة ${l.fifoLot.lotNumber}`
              : `Stock insuffisant : il reste ${remaining} colis sur le lot ${l.fifoLot.lotNumber}`,
          )
          setSaving(false)
          return
        }
      }

      const payloadLines = usedLines.map((l) => ({
        productId: l.productId as string,
        // FOURNISSEUR PAR LIGNE (Option A) : envoyé au back pour le FIFO par ligne.
        supplierId: l.supplierId as string,
        // CALIBRE : restreint la résolution FIFO côté back au lot du calibre.
        caliber: l.caliber && l.caliber.trim() ? l.caliber.trim() : undefined,
        // Le lot n'est PLUS envoyé par le front : le back le résout en FIFO
        // (fournisseur+produit). On laisse lotId undefined volontairement.
        quantity: Number(l.netWeight) || Number(l.colis) || 1,
        colis: l.colis === '' ? null : Number(l.colis),
        grossWeight: l.grossWeight === '' ? null : Number(l.grossWeight),
        tare: l.tare === '' ? null : Number(l.tare),
        netWeight: l.netWeight === '' ? null : Number(l.netWeight),
        unitPrice: Number(l.unitPrice),
        packingUnitPrice:
          l.packingUnitPrice === '' || l.packingUnitPrice == null
            ? 0
            : Number(l.packingUnitPrice),
      }))
      // AUTO-CLIENT SILENCIEUX : si un client existant est sélectionné on envoie
      // customerId ; si l'utilisateur a tapé un nom libre non listé, on envoie
      // customerName (le backend crée le client silencieusement).
      const freeName = !customerId && customerName.trim() ? customerName.trim() : undefined
      // 1) Créer la vente (le back résout le lot FIFO fournisseur+produit)
      const created = await createSale({
        customerId: customerId || undefined,
        customerName: freeName,
        items: payloadLines,
      })
      // 2) Confirmer (sortie de stock FIFO) — NON-BLOQUANT : si la confirmation
      // échoue (ex: stock FIFO insuffisant), on logue mais on CONTINUE vers la
      // facture pour alimenter le bordereau fournisseur.
      try {
        await confirmSale(created.id)
      } catch (confirmErr) {
        console.error('confirmSale failed (non bloquant):', confirmErr)
      }
      // 3) Créer la facture depuis la vente (auto-client via customerName)
      const inv = await createInvoice({
        saleId: created.id,
        customerName: freeName,
      })
      // 4) Persister le prix emballage via PATCH facture (best-effort).
      const hasPacking = payloadLines.some((l) => Number(l.packingUnitPrice || 0) > 0)
      if (hasPacking && inv?.id) {
        try {
          const full = await getInvoice(inv.id)
          const items = (full.items ?? []).map((it: any, i: number) => ({
            description: it.description ?? '',
            productId: it.productId ?? undefined,
            quantity: Number(it.quantity ?? 0),
            unitPrice: Number(it.unitPrice ?? 0),
            colis: it.colis !== undefined ? Number(it.colis) : undefined,
            grossWeight: it.grossWeight !== undefined ? Number(it.grossWeight) : undefined,
            tare: it.tare !== undefined ? Number(it.tare) : undefined,
            netWeight: it.netWeight !== undefined ? Number(it.netWeight) : undefined,
            packingUnitPrice: Number(payloadLines[i]?.packingUnitPrice ?? 0),
          }))
          await updateInvoice(inv.id, { items })
        } catch {
          /* le PATCH d'emballage est best-effort, on ne bloque pas la vente */
        }
      }
      setCreatedSaleId(created.id)
      setCreatedInvoiceId(inv?.id ?? null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // Quick-pay après création (Payé / Différé / Crédit) puis retour à /ventes.
  async function quickPay(mode: 'PAID' | 'PARTIAL' | 'CREDIT') {
    if (!createdInvoiceId) {
      navigate('/ventes')
      return
    }
    try {
      if (mode === 'CREDIT') {
        await issueInvoice(createdInvoiceId)
      } else if (mode === 'PAID') {
        const inv = await getInvoice(createdInvoiceId)
        await createPayment({
          invoiceId: createdInvoiceId,
          amount: Number(inv.total || 0),
          method: 'CASH',
        })
      } else {
        const advance = Number(
          prompt(lang === 'ar' ? 'مبلغ الدفعة المقدمة:' : "Montant de l'avance :") ?? '',
        )
        if (!advance || advance <= 0) return
        await createPayment({
          invoiceId: createdInvoiceId,
          amount: advance,
          method: 'CASH',
        })
      }
      navigate('/ventes')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="space-y-5 w-full px-4 sm:px-6 lg:px-8">
      <PageHeader
        title={lang === 'ar' ? 'جديد' : 'Nouveau'}
        subtitle={lang === 'ar' ? 'إدخال بيع جديد' : 'Saisie d’une nouvelle vente'}
        actions={
          <Button variant="secondary" onClick={() => navigate('/ventes')}>
            {tr('cancel')}
          </Button>
        }
      />
      {error && <ErrorBox message={error} />}

      {createdSaleId ? (
        <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-4 space-y-3">
          <div className="text-sm font-semibold text-green-800">
            {lang === 'ar' ? 'تم إنشاء المحرر. كيف تريد التحصيل؟' : 'Bulletin créé. Comment encaisser ?'}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => quickPay('PAID')}>
              {lang === 'ar' ? 'مدفوع' : 'Payé'}
            </Button>
            <Button variant="secondary" onClick={() => quickPay('PARTIAL')}>
              {lang === 'ar' ? 'دفعة مؤجلة' : 'Paiement différé'}
            </Button>
            <Button variant="ghost" onClick={() => quickPay('CREDIT')}>
              {lang === 'ar' ? 'دائن' : 'Crédit'}
            </Button>
            <Button variant="ghost" onClick={() => navigate('/ventes')}>
              {lang === 'ar' ? 'تم' : 'Terminé'}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={saveNew} className="space-y-5 bg-white rounded-2xl shadow-sm border border-gray-100 p-4 sm:p-6">
          <div className="max-w-md">
            <Field label={lang === 'ar' ? 'العميل' : 'Client'}>
              <SearchSelect
                placeholder={lang === 'ar' ? 'ابحث عن عميل…' : 'Rechercher client…'}
                value={customerName}
                options={custOptions}
                loading={custLoading}
                onQuery={queryCustomer}
                onChange={(t) => {
                  // Texte libre : on capte le nom tapé même sans sélectionner une
                  // suggestion. Toute frappe efface le lien vers un client existant
                  // -> déclenche l'auto-création côté backend (customerName).
                  setCustomerId('')
                  setCustomerName(t)
                }}
                onSelect={(o) => {
                  setCustomerId(o.id)
                  setCustomerName(o.label)
                }}
                onClear={() => {
                  setCustomerId('')
                  setCustomerName('')
                }}
              />
            </Field>
          </div>

          <div className="space-y-3">
            <div className="text-sm font-medium text-gray-700">
              {lang === 'ar' ? 'المواد' : 'Articles'}
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-100">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
                  <tr>
                    <th className="px-2 py-2 text-start font-semibold">
                      {lang === 'ar' ? 'المورد' : 'Fournisseur'}
                    </th>
                    <th className="px-2 py-2 text-start font-semibold">
                      {lang === 'ar' ? 'المنتج' : 'Article'}
                    </th>
                    <th className="px-2 py-2 font-semibold">{lang === 'ar' ? 'العبوات' : 'Colis'}</th>
                    <th className="px-2 py-2 font-semibold">{lang === 'ar' ? 'الوزن' : 'Brut'}</th>
                    <th className="px-2 py-2 font-semibold">{lang === 'ar' ? 'الطرح' : 'Tare'}</th>
                    <th className="px-2 py-2 font-semibold">{lang === 'ar' ? 'الصافي' : 'Net'}</th>
                    <th className="px-2 py-2 font-semibold">{lang === 'ar' ? 'السعر' : 'P.U.'}</th>
                    <th className="px-2 py-2 font-semibold">{lang === 'ar' ? 'سعر التغليف' : 'P.U. Emb.'}</th>
                    <th className="px-2 py-2 text-end font-semibold">{lang === 'ar' ? 'التغليف' : 'Emballage'}</th>
                    <th className="px-2 py-2 text-end font-semibold">{lang === 'ar' ? 'الإجمالي' : 'Total'}</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {lines.map((l, i) => (
                    <LineRow
                      key={i}
                      line={l}
                      suppliers={suppliers}
                      canRemove={lines.length > 1}
                      onChange={(patch) => setLine(i, patch)}
                      onRemove={() => removeLine(i)}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="px-2 py-1 text-gray-600" colSpan={9}>
                      {lang === 'ar' ? 'مجموع المنتجات' : 'Sous-total produits'}
                    </td>
                    <td className="px-2 py-1 text-end font-semibold text-gray-700 whitespace-nowrap">
                      {da(productSubtotal)}
                    </td>
                    <td />
                  </tr>
                  <tr>
                    <td className="px-2 py-1 text-gray-600" colSpan={9}>
                      {lang === 'ar' ? 'مجموع التغليف' : 'Total emballage'}
                    </td>
                    <td className="px-2 py-1 text-end font-semibold text-gray-700 whitespace-nowrap">
                      {da(packingSubtotal)}
                    </td>
                    <td />
                  </tr>
                  <tr className="border-t-2 border-gray-200">
                    <td className="px-2 py-2 font-semibold text-gray-700" colSpan={9}>
                      {lang === 'ar' ? 'الإجمالي العام' : 'Total général'}
                    </td>
                    <td className="px-2 py-2 text-end font-bold text-fruite-green whitespace-nowrap">
                      {da(total)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <Button type="button" variant="secondary" onClick={addLine}>
              {tr('addItem')}
            </Button>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-gray-100">
            <Button type="button" variant="secondary" onClick={() => navigate('/ventes')}>
              {lang === 'ar' ? 'إلغاء' : 'Annuler'}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving
                ? lang === 'ar'
                  ? 'جارٍ الحفظ…'
                  : 'Enregistrement…'
                : lang === 'ar'
                  ? 'إنشاء الفاتورة'
                  : 'Créer la facture'}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
