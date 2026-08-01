// Vue générale de la caisse : liste des journées (Date, Entrées, Sorties, Écart).
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getCashDays, type CashDay } from '../api'
import { PageHeader, Button, Table, Spinner, ErrorBox, EmptyState, Badge } from '../components/ui'
import { fmtDA, fmtDate, statutBadge, aujourdhui } from './caisse-utils'

export default function CaissePage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<CashDay[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await getCashDays()
      setItems(r.items ?? [])
    } catch (e: any) {
      setError(e?.message ?? 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const ecartClass = (v: string) => (Number(v) !== 0 ? 'text-amber-600 font-semibold' : 'text-gray-500')

  return (
    <div>
      <PageHeader
        title="Caisse"
        subtitle="Journées de caisse — entrées, sorties et écarts"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => navigate('/caisse/approvisionnement')}>
              Approvisionnement
            </Button>
            <Button variant="secondary" onClick={() => navigate('/caisse/remise')}>
              Remise
            </Button>
            <Button onClick={() => navigate('/caisse/cloture')}>Clôture du jour</Button>
          </div>
        }
      />

      {error && <ErrorBox message={error} />}
      {loading && <Spinner label="Chargement…" />}

      {!loading && items.length === 0 && (
        <EmptyState message="Aucune journée de caisse enregistrée pour l'instant." />
      )}

      {!loading && items.length > 0 && (
        <>
          {/* Tableau (desktop) */}
          <div className="hidden md:block">
            <Table headers={['Date', 'Statut', 'Entrées', 'Sorties', 'Écart']}>
              {items.map((d) => {
                const b = statutBadge(d.status)
                return (
                  <tr
                    key={d.id}
                    onClick={() => navigate(`/caisse/${d.date}`)}
                    className={`cursor-pointer hover:bg-gray-50 ${
                      d.status === 'cloturee' ? 'bg-blue-50/40' : ''
                    }`}
                  >
                    <td className="px-4 py-3 font-medium text-gray-800">{fmtDate(d.date)}</td>
                    <td className="px-4 py-3">
                      <Badge color={b.color}>{b.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-green-600 font-semibold">{fmtDA(d.totalEntries)}</td>
                    <td className="px-4 py-3 text-red-600 font-semibold">{fmtDA(d.totalOutputs)}</td>
                    <td className={`px-4 py-3 ${ecartClass(d.difference)}`}>{fmtDA(d.difference)}</td>
                  </tr>
                )
              })}
            </Table>
          </div>

          {/* Cartes (mobile) */}
          <div className="md:hidden space-y-3">
            {items.map((d) => {
              const b = statutBadge(d.status)
              return (
                <button
                  key={d.id}
                  onClick={() => navigate(`/caisse/${d.date}`)}
                  className={`w-full text-start bg-white rounded-2xl border border-gray-100 shadow-sm p-4 ${
                    d.status === 'cloturee' ? 'bg-blue-50/40' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-gray-800">{fmtDate(d.date)}</span>
                    <Badge color={b.color}>{b.label}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <div className="text-gray-400">Entrées</div>
                      <div className="text-green-600 font-semibold">{fmtDA(d.totalEntries)}</div>
                    </div>
                    <div>
                      <div className="text-gray-400">Sorties</div>
                      <div className="text-red-600 font-semibold">{fmtDA(d.totalOutputs)}</div>
                    </div>
                    <div>
                      <div className="text-gray-400">Écart</div>
                      <div className={ecartClass(d.difference)}>{fmtDA(d.difference)}</div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}

      <div className="mt-4">
        <Button variant="ghost" onClick={() => navigate(`/caisse/${aujourdhui()}`)}>
          Voir la journée du jour →
        </Button>
      </div>
    </div>
  )
}
