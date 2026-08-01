// Clôture de la journée de caisse : résumé complet + confirmation.
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getCashDay, closeCashDay, openCashDayPdf, type CashDayDetail } from '../api'
import {
  PageHeader, Button, Input, Field, Modal, Spinner, ErrorBox, Badge,
} from '../components/ui'
import { fmtDA, fmtDate, aujourdhui, statutBadge } from './caisse-utils'

function Ligne({ label, value, color = 'text-gray-800', fort = false }: {
  label: string; value: string; color?: string; fort?: boolean
}) {
  return (
    <div className={`flex items-center justify-between py-2 border-b border-gray-100 ${fort ? 'font-bold' : ''}`}>
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm ${color} ${fort ? 'font-bold' : 'font-semibold'}`}>{value}</span>
    </div>
  )
}

export default function CloturePage() {
  const navigate = useNavigate()
  const [date, setDate] = useState(aujourdhui())
  const [data, setData] = useState<CashDayDetail | null>(null)
  const [closingCashFund, setClosingCashFund] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await getCashDay(date))
    } catch (e: any) {
      setError(e?.message ?? 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => {
    load()
  }, [load])

  async function onClose() {
    setSaving(true)
    setError(null)
    try {
      await closeCashDay(date, { closingCashFund: Number(closingCashFund || 0) })
      setConfirm(false)
      navigate(`/caisse/${date}`)
    } catch (e: any) {
      setError(e?.message ?? 'Erreur lors de la clôture')
      setConfirm(false)
    } finally {
      setSaving(false)
    }
  }

  /** Ouvre le bordereau de caisse A5 dans un nouvel onglet. */
  async function imprimerPdf() {
    try {
      await openCashDayPdf(date)
    } catch (e: any) {
      setError(e?.message ?? 'Erreur PDF')
    }
  }

  const t = data?.totaux
  const dejaCloturee = data?.status === 'cloturee'
  const b = statutBadge(data?.status ?? 'ouverte')

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Clôture de caisse"
        subtitle="Vérifiez le résumé avant de clôturer la journée"
        actions={
          <div className="flex gap-2">
            {/* Impression du bordereau de caisse A5 */}
            <Button variant="secondary" onClick={imprimerPdf}>🖨 Imprimer A5</Button>
            <Button variant="secondary" onClick={() => navigate('/caisse')}>← Retour caisse</Button>
          </div>
        }
      />

      <div className="mb-4 max-w-xs">
        <Field label="Journée à clôturer">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>

      {error && <ErrorBox message={error} />}
      {loading && <Spinner label="Chargement…" />}

      {!loading && t && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-gray-800">Résumé du {fmtDate(date)}</h2>
            <Badge color={b.color}>{b.label}</Badge>
          </div>

          <Ligne label="Ancien fonds de caisse" value={fmtDA(t.openingCashFund)} />
          <Ligne label="Total des factures du jour" value={fmtDA(t.invoiceTotal)} color="text-green-600" />
          <Ligne label="Encaissements de crédits clients" value={fmtDA(t.creditCollectionTotal)} color="text-green-600" />
          <Ligne label="Approvisionnements" value={fmtDA(t.cashSupplyTotal)} color="text-green-600" />
          <Ligne label="TOTAL ENTRÉES" value={fmtDA(t.totalEntries)} color="text-green-700" fort />

          <div className="h-4" />
          <Ligne label="Crédits créés (factures non encaissées)" value={fmtDA(t.creditInvoiceTotal)} color="text-amber-600" />
          <Ligne label="Non encaissé (factures partielles)" value={fmtDA(t.unpaidPartialInvoiceTotal)} color="text-amber-600" />
          <Ligne label="Dépenses" value={fmtDA(t.expenseTotal)} color="text-red-600" />
          <Ligne label="Remises d'espèces" value={fmtDA(t.cashRemittanceTotal)} color="text-red-600" />
          <Ligne label="TOTAL SORTIES (hors nouveau fonds)" value={fmtDA(t.totalOutputs)} color="text-red-700" fort />

          <div className="h-4" />
          <Ligne
            label="Écart (entrées − sorties)"
            value={fmtDA(t.difference)}
            color={Number(t.difference) !== 0 ? 'text-amber-600' : 'text-gray-800'}
            fort
          />
          <Ligne label="Encaissement réel des ventes" value={fmtDA(t.encaissementReelVentes)} color="text-green-700" />

          {!dejaCloturee ? (
            <div className="mt-5 space-y-3">
              <Field label="Nouveau fonds de caisse (montant laissé en caisse, DA) *">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={closingCashFund}
                  onChange={(e) => setClosingCashFund(e.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <p className="text-xs text-gray-400">
                Ce montant devient automatiquement le fonds d'ouverture de la journée du lendemain.
              </p>
              <Button
                className="w-full"
                disabled={saving || closingCashFund === ''}
                onClick={() => setConfirm(true)}
              >
                Clôturer la journée
              </Button>
            </div>
          ) : (
            <div className="mt-5 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
              Journée déjà clôturée
              {data?.closedBy ? ` par ${data.closedBy}` : ''}
              {data?.closedAt ? ` le ${new Date(data.closedAt).toLocaleString('fr-FR')}` : ''}. Nouveau fonds :{' '}
              {fmtDA(t.closingCashFund)}.
            </div>
          )}
        </div>
      )}

      <Modal
        open={confirm}
        title="Confirmer la clôture"
        onClose={() => setConfirm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Annuler
            </Button>
            <Button onClick={onClose} disabled={saving}>
              {saving ? 'Clôture…' : 'Confirmer'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-gray-600">
          Vous êtes sur le point de clôturer la caisse du <strong>{fmtDate(date)}</strong> avec un nouveau
          fonds de <strong>{fmtDA(closingCashFund)}</strong>. Cette opération est définitive.
        </p>
      </Modal>
    </div>
  )
}
