import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  getInvoice,
  openInvoicePdf,
  updateInvoice,
  getProductSearch,
  type ProductSearchItem,
} from '../api'
import type { Invoice } from '../types'
import {
  PageHeader,
  Spinner,
  ErrorBox,
  Button,
  Input,
  Field,
  Badge,
  SearchSelect,
  type SearchSelectOption,
} from '../components/ui'
import { useLang } from '../i18n'

const da = (n: string | number | null | undefined) =>
  `${Number(n || 0).toLocaleString('fr-FR')} DA`

function invoiceStatusBadge(
  status: string,
  remaining?: string | number,
  total?: string | number,
): { label: string; color: string } {
  if (
    status === 'SENT' &&
    Number(total ?? 0) > 0 &&
    Number(remaining ?? 0) === Number(total ?? 0)
  ) {
    return { label: 'Crédit', color: 'blue' }
  }
  switch (status) {
    case 'PAID':
      return { label: 'Payé', color: 'green' }
    case 'SENT':
      return { label: 'Émis', color: 'blue' }
    case 'CANCELLED':
      return { label: 'Annulé', color: 'red' }
    case 'PARTIALLY_PAID':
      return { label: 'Avance', color: 'amber' }
    default:
      return { label: 'Brouillon', color: 'gray' }
  }
}

// ---------------------------------------------------------------------
// Sélecteur produit pour une NOUVELLE ligne ajoutée en mode édition
// (même saisie que « Nouvelle vente » : autocomplete produit FR/AR).
// ---------------------------------------------------------------------
function ProductPicker({
  value,
  onPick,
}: {
  value: string
  onPick: (p: { id: string; label: string }) => void
}) {
  const { lang } = useLang()
  const [options, setOptions] = useState<SearchSelectOption[]>([])
  const [loading, setLoading] = useState(false)
  const [text, setText] = useState(value)

  async function query(q: string) {
    setLoading(true)
    try {
      const r = await getProductSearch(q)
      setOptions(
        (r.items ?? []).map((p: ProductSearchItem) => ({
          id: p.id,
          label: lang === 'ar' ? p.nameAr || p.name : p.name,
        })),
      )
    } catch {
      setOptions([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <SearchSelect
      placeholder={lang === 'ar' ? 'ابحث عن منتج…' : 'Rechercher produit…'}
      value={text}
      options={options}
      loading={loading}
      onQuery={query}
      onChange={(t) => {
        setText(t)
        onPick({ id: '', label: t })
      }}
      onSelect={(o) => {
        setText(o.label)
        onPick({ id: o.id, label: o.label })
      }}
      onClear={() => {
        setText('')
        onPick({ id: '', label: '' })
      }}
    />
  )
}

const fmtDate = (d?: string | null) => {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-FR')
}

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>()
  const { lang } = useLang()
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!id) return
    void (async () => {
      setLoading(true)
      setError('')
      try {
        const inv = await getInvoice(id)
        setInvoice(inv)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [id])

  async function saveDetail(e: React.FormEvent) {
    e.preventDefault()
    if (!invoice) return
    setSaving(true)
    setError('')
    try {
      // On renvoie TOUTES les lignes (existantes + nouvelles) car le backend
      // fait un REPLACE des lignes. Les lignes vides (ajout non renseigné)
      // sont ignorées.
      const items = (invoice.items ?? [])
        .filter(
          (it: any) =>
            (it.productId || (it.description ?? '').trim()) &&
            Number(it.unitPrice ?? 0) > 0,
        )
        .map((it: any) => ({
        description: (it as any).description ?? '',
        productId: (it as any).productId ?? undefined,
        quantity: Number((it as any).quantity ?? 0),
        unitPrice: Number((it as any).unitPrice ?? 0),
        packingUnitPrice:
          (it as any).packingUnitPrice !== undefined
            ? Number((it as any).packingUnitPrice)
            : undefined,
        colis: (it as any).colis !== undefined ? Number((it as any).colis) : undefined,
        grossWeight:
          (it as any).grossWeight !== undefined
            ? Number((it as any).grossWeight)
            : undefined,
        tare: (it as any).tare !== undefined ? Number((it as any).tare) : undefined,
        netWeight:
          (it as any).netWeight !== undefined
            ? Number((it as any).netWeight)
            : undefined,
      }))
      await updateInvoice(invoice.id, {
        items,
        packingReturned: (invoice as any).packingReturned ?? undefined,
      })
      const fresh = await getInvoice(invoice.id)
      setInvoice(fresh)
      setEdit(false)
    } catch (e) {
      console.error('saveDetail error', e)
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // RÈGLE 2 (c) : facture soldée (restant = 0 ou statut PAID) = VERROUILLÉE.
  const isLocked =
    !!invoice &&
    (invoice.status === 'PAID' ||
      Number(invoice.remaining ?? invoice.total ?? 0) <= 0)

  // RÈGLE 2 (a) : ajout d'une NOUVELLE ligne au tableau d'édition.
  function addItem() {
    if (!invoice) return
    const items = [
      ...((invoice.items ?? []) as any[]),
      {
        id: undefined,
        _new: true,
        description: '',
        productId: undefined,
        quantity: 0,
        unitPrice: '',
        packingUnitPrice: '',
        colis: '',
        grossWeight: '',
        tare: '',
        netWeight: '',
      },
    ]
    setInvoice({ ...invoice, items } as Invoice)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={lang === 'ar' ? 'تفاصيل الفاتورة' : 'Détail de la facture'}
        subtitle={invoice?.reference ?? ''}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => window.close()}>
              {lang === 'ar' ? 'إغلاق' : 'Fermer'}
            </Button>
            {!edit && (
              <Button
                variant="secondary"
                onClick={() => setEdit(true)}
                disabled={!invoice || isLocked}
                title={
                  isLocked
                    ? lang === 'ar'
                      ? 'فاتورة مدفوعة — مقفلة'
                      : 'Facture payée — verrouillée'
                    : undefined
                }
              >
                {lang === 'ar' ? 'تعديل' : 'Modifier'}
              </Button>
            )}
            <Button
              onClick={() => {
                if (invoice) void openInvoicePdf(invoice.id)
              }}
            >
              {lang === 'ar' ? 'طباعة' : 'Imprimer'}
            </Button>
          </div>
        }
      />

      {error && <ErrorBox message={error} />}

      {loading ? (
        <Spinner label={lang === 'ar' ? 'جارٍ التحميل…' : 'Chargement…'} />
      ) : !invoice ? (
        <ErrorBox message={lang === 'ar' ? 'فاتورة غير موجودة' : 'Facture introuvable'} />
      ) : (
        <div className="space-y-5">
          {/* En-tête facture */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <span className="text-lg font-bold text-gray-800">{invoice.reference}</span>
            <Badge
              color={invoiceStatusBadge(
                invoice.status,
                invoice.remaining,
                invoice.total,
              ).color}
            >
              {invoiceStatusBadge(
                invoice.status,
                invoice.remaining,
                invoice.total,
              ).label}
            </Badge>
            <span className="text-sm text-gray-500">
              {lang === 'ar' ? 'التاريخ' : 'Date'}: {fmtDate(invoice.issueDate)}
            </span>
            <span className="text-sm text-gray-700">
              {lang === 'ar' ? 'العميل' : 'Client'}: {invoice.customer?.name ?? '—'}
            </span>
          </div>

          {/* Tableau / formulaire des lignes */}
          <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            {edit ? (
              <form id="detail-form" onSubmit={saveDetail} className="space-y-2">
                {(invoice.items ?? []).map((it: any, i: number) => (
                  <div key={it.id ?? i} className="grid grid-cols-7 gap-2 items-end">
                    <Field label={lang === 'ar' ? 'المنتج' : 'Produit'}>
                      {it._new ? (
                        <ProductPicker
                          value={it.description ?? ''}
                          onPick={(p) => {
                            const items = [...(invoice.items ?? [])]
                            ;(items[i] as any).productId = p.id || undefined
                            ;(items[i] as any).description = p.label
                            setInvoice({ ...invoice, items })
                          }}
                        />
                      ) : (
                        <Input
                          value={it.description ?? it.product?.name ?? ''}
                          onChange={(e) => {
                            const items = [...(invoice.items ?? [])]
                            ;(items[i] as any).description = e.target.value
                            setInvoice({ ...invoice, items })
                          }}
                        />
                      )}
                    </Field>
                    <Field label={lang === 'ar' ? 'العبوات' : 'Colis'}>
                      <Input
                        type="number"
                        value={it.colis ?? ''}
                        onChange={(e) => {
                          const items = [...(invoice.items ?? [])]
                          const b = Number((items[i] as any).grossWeight || 0)
                          const t = Number((items[i] as any).tare || 0)
                          ;(items[i] as any).colis = e.target.value
                          ;(items[i] as any).netWeight = String(b - t * Number(e.target.value || 0))
                          ;(items[i] as any).quantity = String(b - t * Number(e.target.value || 0))
                          setInvoice({ ...invoice, items })
                        }}
                      />
                    </Field>
                    <Field label={lang === 'ar' ? 'الوزن' : 'Brut (kg)'}>
                      <Input
                        type="number"
                        value={it.grossWeight ?? ''}
                        onChange={(e) => {
                          const items = [...(invoice.items ?? [])]
                          ;(items[i] as any).grossWeight = e.target.value
                          const b = Number(e.target.value || 0)
                          const t = Number((items[i] as any).tare || 0)
                          const c = Number((items[i] as any).colis || 0)
                          // Net = Brut − (Tare × Colis)
                          ;(items[i] as any).netWeight = String(b - t * c)
                          ;(items[i] as any).quantity = String(b - t * c)
                          setInvoice({ ...invoice, items })
                        }}
                      />
                    </Field>
                    <Field label={lang === 'ar' ? 'الطرح' : 'Tare (kg)'}>
                      <Input
                        type="number"
                        value={it.tare ?? ''}
                        onChange={(e) => {
                          const items = [...(invoice.items ?? [])]
                          ;(items[i] as any).tare = e.target.value
                          const b = Number((items[i] as any).grossWeight || 0)
                          const t = Number(e.target.value || 0)
                          const c = Number((items[i] as any).colis || 0)
                          // Net = Brut − (Tare × Colis)
                          ;(items[i] as any).netWeight = String(b - t * c)
                          ;(items[i] as any).quantity = String(b - t * c)
                          setInvoice({ ...invoice, items })
                        }}
                      />
                    </Field>
                    <Field label={lang === 'ar' ? 'الصافي' : 'Net (kg)'}>
                      <Input
                        type="number"
                        value={it.netWeight ?? ''}
                        disabled
                        readOnly
                      />
                    </Field>
                    <Field label="PU (DA)">
                      <Input
                        type="number"
                        value={it.unitPrice ?? ''}
                        onChange={(e) => {
                          const items = [...(invoice.items ?? [])]
                          ;(items[i] as any).unitPrice = e.target.value
                          setInvoice({ ...invoice, items })
                        }}
                      />
                    </Field>
                    <Field label={lang === 'ar' ? 'سعر التغليف / صندوق' : 'Prix emb. / colis'}>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={it.packingUnitPrice ?? ''}
                        onChange={(e) => {
                          const items = [...(invoice.items ?? [])]
                          ;(items[i] as any).packingUnitPrice = e.target.value
                          setInvoice({ ...invoice, items })
                        }}
                      />
                    </Field>
                  </div>
                ))}
                <div className="pt-2">
                  {/* RÈGLE 2 (a) : ajout d'article (pas de suppression de ligne). */}
                  <Button type="button" variant="secondary" onClick={addItem}>
                    {lang === 'ar' ? '+ إضافة مادة' : '+ Ajouter un article'}
                  </Button>
                </div>
                <div className="flex justify-end gap-2 pt-3 border-t border-gray-100">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setEdit(false)}
                    disabled={saving}
                  >
                    {lang === 'ar' ? 'إلغاء' : 'Annuler'}
                  </Button>
                  <Button type="submit" variant="primary" disabled={saving}>
                    {lang === 'ar' ? 'حفظ' : 'Enregistrer'}
                  </Button>
                </div>
              </form>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-gray-500">
                  <tr>
                    <th className="text-start py-2">{lang === 'ar' ? 'المنتج' : 'Produit'}</th>
                    <th className="text-end py-2">{lang === 'ar' ? 'العبوات' : 'Colis'}</th>
                    <th className="text-end py-2">{lang === 'ar' ? 'الوزن' : 'Brut (kg)'}</th>
                    <th className="text-end py-2">{lang === 'ar' ? 'الطرح' : 'Tare (kg)'}</th>
                    <th className="text-end py-2">{lang === 'ar' ? 'الصافي' : 'Net (kg)'}</th>
                    <th className="text-end py-2">PU</th>
                    <th className="text-end py-2">{lang === 'ar' ? 'سعر التغليف' : 'PU Emb.'}</th>
                    <th className="text-end py-2">{lang === 'ar' ? 'التغليف' : 'Emballage'}</th>
                    <th className="text-end py-2">{lang === 'ar' ? 'الإجمالي' : 'Total'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(invoice.items ?? []).map((it: any, i: number) => (
                    <tr key={it.id ?? i}>
                      <td className="py-2">{`${it.description ?? it.product?.name ?? '—'}${(it as any).caliber ? ' / ' + (it as any).caliber : ''}`}</td>
                      <td className="py-2 text-end">{it.colis ?? 0} colis</td>
                      <td className="py-2 text-end">{it.grossWeight ?? 0} kg</td>
                      <td className="py-2 text-end">{it.tare ?? 0} kg</td>
                      <td className="py-2 text-end">{it.netWeight ?? 0} kg</td>
                      <td className="py-2 text-end">{da(it.unitPrice)}</td>
                      <td className="py-2 text-end">{da(it.packingUnitPrice)}</td>
                      <td className="py-2 text-end text-gray-600">
                        {da(Number(it.packingUnitPrice || 0) * Number(it.colis || 0))}
                      </td>
                      <td className="py-2 text-end font-semibold text-fruite-green">{da(it.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={8} className="py-2 text-gray-600">
                      {lang === 'ar' ? 'مجموع التغليف' : 'Total emballage'}
                    </td>
                    <td className="py-2 text-end text-gray-700">{da(invoice.packingTotal ?? 0)}</td>
                  </tr>
                  <tr className="border-t-2 border-gray-200">
                    <td colSpan={8} className="py-2 font-semibold">
                      {lang === 'ar' ? 'الإجمالي' : 'Total'}
                    </td>
                    <td className="py-2 text-end font-bold text-fruite-green">{da(invoice.total)}</td>
                  </tr>
                  <tr>
                    <td colSpan={8} className="py-2 font-semibold text-blue-600">
                      {lang === 'ar' ? 'الدفعة' : 'Avance'}
                    </td>
                    <td className="py-2 text-end font-semibold text-blue-600">{da(invoice.paidAmount ?? 0)}</td>
                  </tr>
                  <tr>
                    <td colSpan={8} className="py-2 font-semibold text-red-600">
                      {lang === 'ar' ? 'الباقي' : 'Restant'}
                    </td>
                    <td className="py-2 text-end font-semibold text-red-600">
                      {da(invoice.remaining ?? invoice.total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>

          {/* Historique de paiement */}
          <div className="mt-6 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <h3 className="mb-3 text-base font-semibold text-gray-800">
              {lang === 'ar' ? 'سجل الدفع' : 'Historique de paiement'}
            </h3>
            {(() => {
              const total = Number(invoice.total ?? 0)
              // Calcul du cumul dans l'ordre CHRONOLOGIQUE (ASC) puis inversion pour affichage (récent en haut)
              const sortedAsc = [...(invoice.payments ?? [])].sort(
                (a: any, b: any) =>
                  new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime()
              )
              let cumul = 0
              const rowsAsc: Array<{
                key: string
                ref: string
                date: string | null
                avance: number
                reste: number
                statusLabel: string
                statusColor: string
                isRecent: boolean
              }> = sortedAsc.map((p: any) => {
                cumul += Number(p.amount || 0)
                const reste = total - cumul
                return {
                  key: p.id,
                  ref: invoice.reference,
                  date: p.paymentDate,
                  avance: Number(p.amount || 0),
                  reste,
                  statusLabel: reste <= 0 ? (lang === 'ar' ? 'مدفوع' : 'Payé') : (lang === 'ar' ? 'دفعة' : 'Avance'),
                  statusColor: reste <= 0 ? 'green' : 'amber',
                  isRecent: false,
                }
              })
              // Inverse pour affichage (récent en haut)
              const rows = [...rowsAsc].reverse()
              // isRecent = 1ère ligne affichée = rows[0]
              rows.forEach((r, i) => {
                r.isRecent = i === 0
              })
              // Ligne facture en bas (non cliquable) — statut RÉEL de la facture,
              // pas un libellé en dur. DRAFT -> Brouillon, PAID -> Payé, SENT+restant
              // total -> Crédit, etc. (voir invoiceStatusBadge plus haut).
              const invBadge = invoiceStatusBadge(
                invoice.status,
                (invoice as any).remaining ?? total,
                total,
              )
              rows.push({
                key: 'inv',
                ref: invoice.reference,
                date: (invoice.issueDate ?? invoice.createdAt) as string | null,
                avance: 0,
                reste: total,
                statusLabel: invBadge.label,
                statusColor: invBadge.color,
                isRecent: rows.length === 0,
              })
              return (
                <>
                  <table className="w-full text-sm">
                  <thead className="text-gray-500">
                    <tr>
                      <th className="text-start py-2">{lang === 'ar' ? 'رقم الفاتورة' : 'N° facture'}</th>
                      <th className="text-start py-2">{lang === 'ar' ? 'التاريخ' : 'Date'}</th>
                      <th className="text-end py-2">{lang === 'ar' ? 'الدفعة المدفوعة' : 'Avance faite'}</th>
                      <th className="text-end py-2">{lang === 'ar' ? 'المتبقي للدفع' : 'Reste à payer'}</th>
                      <th className="text-start py-2">{lang === 'ar' ? 'الحالة' : 'Statut'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.map((row) => (
                      <tr key={row.key} className={row.isRecent ? 'bg-blue-50' : ''}>
                        <td className="py-2">
                          {row.isRecent ? (
                            <span
                              className="cursor-pointer text-blue-600 underline"
                              onClick={() => void openInvoicePdf(invoice.id)}
                            >
                              {row.ref}
                            </span>
                          ) : (
                            <span>{row.ref}</span>
                          )}
                        </td>
                        <td className="py-2">{fmtDate(row.date)}</td>
                        <td className="py-2 text-end">{da(row.avance)}</td>
                        <td className="py-2 text-end">{da(row.reste)}</td>
                        <td className="py-2">
                          <Badge color={row.statusColor}>{row.statusLabel}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm border-t border-gray-100 pt-3">
                  <span>
                    <span className="text-gray-500">Total emballage :</span> {da(invoice.packingTotal ?? 0)}
                  </span>
                  <span>
                    <span className="text-gray-500">Avance :</span> {da(invoice.paidAmount ?? 0)}
                  </span>
                  <span className="font-semibold text-red-600">
                    <span className="text-gray-500 font-normal">Reste à payer :</span> {da(invoice.remaining ?? invoice.total)}
                  </span>
                  <span>
                    <span className="text-gray-500">Total :</span> {da(invoice.total ?? 0)}
                  </span>
                </div>
                </>
              )
            })()}
          </div>

          {/* Boutons bas de page */}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => window.history.back()}>
              {lang === 'ar' ? 'رجوع' : 'Retour'}
            </Button>
            <Button onClick={() => void openInvoicePdf(invoice.id)}>
              {lang === 'ar' ? 'طباعة / PDF' : 'Imprimer / PDF'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
