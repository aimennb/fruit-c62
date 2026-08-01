import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getStock, postStockLoss } from '../api'
import type { StockResult, StockLot } from '../types'
import {
  PageHeader,
  Spinner,
  ErrorBox,
  Button,
  Input,
  Textarea,
  Field,
  Modal,
  EmptyState,
  Table,
  Badge,
} from '../components/ui'
import { useLang } from '../i18n'

const da = (n: string | number | null | undefined) =>
  `${Number(n || 0).toLocaleString('fr-FR')} DA`

export default function Stock() {
  const { lang, tr } = useLang()
  const navigate = useNavigate()
  const [data, setData] = useState<StockResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showLoss, setShowLoss] = useState(false)
  const [lotId, setLotId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const d = await getStock()
      setData(d)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function declareLoss(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await postStockLoss({ lotId, quantity: Number(quantity), reason })
      setShowLoss(false)
      setLotId('')
      setQuantity('')
      setReason('')
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner label={tr('loading')} />
  if (!data) return <EmptyState message={tr('noData')} />

  return (
    <div className="space-y-6">
      <PageHeader
        title={tr('stock')}
        subtitle={`${lang === 'ar' ? 'القيمة الإجمالية' : 'Valeur totale'}: ${da(data.totalValue)}`}
        actions={<Button onClick={() => setShowLoss(true)}>{lang === 'ar' ? 'إعلان خسارة' : 'Déclarer perte'}</Button>}
      />
      {error && <ErrorBox message={error} />}

      <div className="space-y-3">
        <h2 className="font-bold text-gray-700">{lang === 'ar' ? 'المنتجات' : 'Produits'}</h2>
        <Table
          headers={[
            lang === 'ar' ? 'المنتج' : 'Produit',
            lang === 'ar' ? 'الكمية' : 'Quantité',
            lang === 'ar' ? 'القيمة' : 'Valeur',
            lang === 'ar' ? 'الحالة' : 'Statut',
          ]}
        >
          {data.products.map((p) => {
            const q = Number(p.quantity || 0)
            const rl = Number(p.reorderLevel || 0)
            const alert = q <= rl || q === 0
            return (
              <tr key={p.productId}>
                <td className="px-4 py-3 font-medium">{p.name}</td>
                <td className="px-4 py-3">{p.quantity}</td>
                <td className="px-4 py-3">{da(p.value)}</td>
                <td className="px-4 py-3">
                  {alert ? <Badge color="red">{tr('alert')}</Badge> : <Badge color="green">OK</Badge>}
                </td>
              </tr>
            )
          })}
        </Table>
      </div>

      <div className="space-y-3">
        <h2 className="font-bold text-gray-700">{lang === 'ar' ? 'الدفعات' : 'Lots'}</h2>
        <Table
          headers={[
            lang === 'ar' ? 'رقم الدفعة' : 'Lot',
            lang === 'ar' ? 'المنتج' : 'Produit',
            lang === 'ar' ? 'المورد' : 'Fournisseur',
            lang === 'ar' ? 'البورتير' : 'Bordereau',
            lang === 'ar' ? 'الكمية' : 'Quantité',
            lang === 'ar' ? 'الحالة' : 'Statut',
          ]}
        >
          {data.lots.map((l: StockLot) => {
            const soldOut = (l as StockLot & { soldOut?: boolean }).soldOut ?? Number(l.quantity || 0) <= 0
            return (
              <tr key={l.lotId}>
                <td className="px-4 py-3 font-medium">{l.lotNumber}</td>
                <td className="px-4 py-3">{l.productName}</td>
                <td className="px-4 py-3">
                  {l.supplierId ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/fournisseurs/detail?id=${l.supplierId}`)}
                      className="text-blue-600 underline hover:text-blue-800"
                    >
                      {l.supplierName || '—'}
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-3">
                  {l.bordereauId ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/bordereaux/${l.bordereauId}`)}
                      className="text-green-600 underline hover:text-green-800"
                    >
                      {l.bordereauRef || '—'}
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-3">{l.quantity}</td>
                <td className="px-4 py-3">
                  {soldOut ? (
                    <Badge color="red">{lang === 'ar' ? 'بيع الكل' : 'tout vendu'}</Badge>
                  ) : (
                    <Badge color="green">{lang === 'ar' ? 'متوفر' : 'dispo'}</Badge>
                  )}
                </td>
              </tr>
            )
          })}
        </Table>
      </div>

      <Modal
        open={showLoss}
        title={lang === 'ar' ? 'إعلان خسارة' : 'Déclarer une perte'}
        onClose={() => setShowLoss(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowLoss(false)}>{tr('cancel')}</Button>
            <Button form="loss-form" type="submit" disabled={saving}>{tr('save')}</Button>
          </>
        }
      >
        <form id="loss-form" onSubmit={declareLoss} className="space-y-4 max-w-2xl">
          <Field label={tr('lot')}>
            <select
              className="min-h-[44px] w-full rounded-xl border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-fruite-green/40 focus:border-fruite-green"
              value={lotId}
              required
              onChange={(e) => setLotId(e.target.value)}
            >
              <option value="">—</option>
              {data.lots.filter((l) => Number(l.quantity || 0) > 0).map((l) => (
                <option key={l.lotId} value={l.lotId}>{l.lotNumber} — {l.productName}</option>
              ))}
            </select>
          </Field>
          <Field label={tr('quantity')}>
            <Input type="number" step="0.01" value={quantity} required onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label={tr('reason')}>
            <Textarea value={reason} required onChange={(e) => setReason(e.target.value)} />
          </Field>
        </form>
      </Modal>
    </div>
  )
}
