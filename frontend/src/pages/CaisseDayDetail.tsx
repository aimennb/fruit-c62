// Détail d'une journée de caisse : en-tête de synthèse + tableaux entrées/sorties.
import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getCashDay, openCashDayPdf, type CashDayDetail } from '../api'
import { useLang } from '../i18n'
import { PageHeader, Button, Table, Spinner, ErrorBox, EmptyState, Badge } from '../components/ui'
import { fmtDA, fmtDate, statutBadge } from './caisse-utils'

function Stat({ label, value, color = 'text-gray-800' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <div className="text-xs text-gray-400">{label}</div>
      <div className={`text-lg font-bold mt-1 ${color}`}>{value}</div>
    </div>
  )
}

/** Stat cliquable : mène à la liste des documents correspondants. */
function StatLink({
  label,
  value,
  to,
  color = 'text-gray-800',
}: {
  label: string
  value: string
  to: string
  color?: string
}) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="text-left w-full bg-white rounded-2xl border border-blue-100 shadow-sm p-4 cursor-pointer transition hover:border-blue-400 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-300"
    >
      <div className="text-xs text-blue-500 flex items-center justify-between gap-2">
        <span>{label}</span>
        <span aria-hidden="true">↗</span>
      </div>
      <div className={`text-lg font-bold mt-1 underline decoration-dotted underline-offset-4 ${color}`}>
        {value}
      </div>
    </button>
  )
}

export default function CaisseDayDetail() {
  const { date } = useParams<{ date: string }>()
  const navigate = useNavigate()
  const { lang } = useLang()
  const ar = lang === 'ar'
  const [data, setData] = useState<CashDayDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!date) return
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

  /** Ouvre le bordereau de caisse A5 dans un nouvel onglet. */
  async function imprimerPdf() {
    if (!date) return
    try {
      await openCashDayPdf(date)
    } catch (e: any) {
      setError(e?.message ?? 'Erreur PDF')
    }
  }

  if (loading) return <Spinner label="Chargement de la journée…" />
  if (error) return <ErrorBox message={error} />
  if (!data) return <EmptyState message="Journée introuvable." />

  const t = data.totaux
  const b = statutBadge(data.status)
  const ecartColor = Number(t.difference) !== 0 ? 'text-amber-600' : 'text-gray-800'

  return (
    <div>
      <PageHeader
        title={`Caisse du ${fmtDate(data.date)}`}
        subtitle="Détail des entrées et sorties de la journée"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/caisse')}>
              ← Retour
            </Button>
            {/* Impression du bordereau de caisse A5 */}
            <Button variant="secondary" onClick={imprimerPdf}>
              🖨 Imprimer A5
            </Button>
            {data.status !== 'cloturee' && (
              <Button onClick={() => navigate('/caisse/cloture')}>Clôturer</Button>
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-gray-500">
        <Badge color={b.color}>{b.label}</Badge>
        {data.closedBy && <span>Clôturée par : {data.closedBy}</span>}
        {data.closedAt && <span>le {new Date(data.closedAt).toLocaleString('fr-FR')}</span>}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
        <Stat label="Ancien fonds de caisse" value={fmtDA(t.openingCashFund)} />
        <Stat label="Total entrées" value={fmtDA(t.totalEntries)} color="text-green-600" />
        <Stat label="Total sorties" value={fmtDA(t.totalOutputs)} color="text-red-600" />
        <Stat label="Écart" value={fmtDA(t.difference)} color={ecartColor} />
        <Stat label="Nouveau fonds de caisse" value={fmtDA(t.closingCashFund)} color="text-blue-600" />
        <Stat
          label="Encaissement réel des ventes"
          value={fmtDA(t.encaissementReelVentes)}
          color="text-green-700"
        />
      </div>

      {/* Synthèses navigables : cliquer mène à la liste des documents du jour. */}
      <h2 className="text-sm font-semibold text-gray-500 mb-2">
        {ar ? 'التفاصيل (قابلة للنقر)' : 'Détail des documents (cliquable)'}
      </h2>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
        <StatLink
          label={ar ? 'فواتير اليوم' : 'Total factures du jour'}
          value={fmtDA(t.invoiceTotal)}
          to={`/caisse/${date}/factures`}
          color="text-green-600"
        />
        <StatLink
          label={ar ? 'تحصيل ديون الزبائن' : 'Encaissements de crédits client'}
          value={fmtDA(t.creditCollectionTotal)}
          to={`/caisse/${date}/credits-encaisses`}
          color="text-green-600"
        />
        <StatLink
          label={ar ? 'المصاريف' : 'Total dépenses'}
          value={fmtDA(t.expenseTotal)}
          to={`/caisse/${date}/depenses`}
          color="text-red-600"
        />
        <StatLink
          label={ar ? 'مبيعات بالدين' : 'Crédits créés (ventes à crédit)'}
          value={fmtDA(t.creditInvoiceTotal)}
          to={`/caisse/${date}/credits-crees`}
          color="text-red-600"
        />
        <StatLink
          label={ar ? 'تسليمات نقدية' : 'Remises espèces'}
          value={fmtDA(t.cashRemittanceTotal)}
          to={`/caisse/${date}/remises`}
          color="text-red-600"
        />
      </div>

      {/* ---- Entrées ---- */}
      <h2 className="text-lg font-bold text-gray-800 mb-2">Entrées</h2>
      {data.entries.length === 0 ? (
        <EmptyState message="Aucune entrée pour cette journée." />
      ) : (
        <div className="mb-8">
          <Table headers={['Référence', 'Motif / Catégorie', 'Montant', 'Type', 'Heure', 'Origine']}>
            {data.entries.map((e) => (
              <tr key={e.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-600">{e.reference ?? '—'}</td>
                <td className="px-4 py-3 font-medium text-gray-800">
                  {e.category}
                  {e.description && <div className="text-xs text-gray-400">{e.description}</div>}
                </td>
                <td className="px-4 py-3 text-green-600 font-semibold">{fmtDA(e.amount)}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{e.sourceType}</td>
                <td className="px-4 py-3 text-gray-500">
                  {e.createdAt ? new Date(e.createdAt).toLocaleTimeString('fr-FR').slice(0, 5) : '—'}
                </td>
                <td className="px-4 py-3">
                  <Badge color={e.virtuel ? 'blue' : 'gray'}>
                    {e.virtuel ? 'Automatique' : 'Saisie manuelle'}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      {/* ---- Sorties ---- */}
      <h2 className="text-lg font-bold text-gray-800 mb-2">Sorties</h2>
      {data.outputs.length === 0 ? (
        <EmptyState message="Aucune sortie pour cette journée." />
      ) : (
        <Table headers={['Référence', 'Motif / Catégorie', 'Montant', 'Type', 'Nature', 'Origine']}>
          {data.outputs.map((s) => (
            <tr key={s.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-600">{s.reference ?? '—'}</td>
              <td className="px-4 py-3 font-medium text-gray-800">
                {s.category}
                {s.description && <div className="text-xs text-gray-400">{s.description}</div>}
              </td>
              <td className="px-4 py-3 text-red-600 font-semibold">{fmtDA(s.amount)}</td>
              <td className="px-4 py-3 text-xs text-gray-500">{s.sourceType}</td>
              <td className="px-4 py-3">
                {/* Distinction visuelle : sortie réelle d'argent vs déduction comptable */}
                <Badge color={s.deduction ? 'amber' : 'red'}>
                  {s.deduction ? 'Déduction de rapprochement' : 'Sortie réelle'}
                </Badge>
              </td>
              <td className="px-4 py-3">
                <Badge color={s.virtuel ? 'blue' : 'gray'}>
                  {s.virtuel ? 'Automatique' : 'Saisie manuelle'}
                </Badge>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}
