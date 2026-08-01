// =====================================================================
// useBarcodeSearch — branche une barre de recherche EXISTANTE sur le
// scanner code-barres USB (qui saisit comme un clavier).
//   • Dès que la valeur saisie est un EAN13 (13 chiffres), on interroge
//     GET /api/search?q=... et on REDIRIGE vers le document trouvé.
//   • Sinon : rien (le filtrage texte local de la page reste intact).
// =====================================================================
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { searchByQuery, type DocSearchHit, type DocSearchListResult } from '../api'

export function useBarcodeSearch(
  value: string,
  opts?: { onNotFound?: (msg: string) => void; onResolved?: () => void },
) {
  const navigate = useNavigate()
  const lastRef = useRef<string>('')
  const onNotFound = opts?.onNotFound
  const onResolved = opts?.onResolved

  useEffect(() => {
    const v = (value ?? '').trim()
    if (!/^\d{13}$/.test(v)) return
    if (lastRef.current === v) return
    lastRef.current = v
    let cancelled = false
    ;(async () => {
      try {
        const res = (await searchByQuery(v)) as DocSearchHit | DocSearchListResult
        if (cancelled) return
        if ((res as DocSearchHit)?.url) {
          onResolved?.()
          navigate((res as DocSearchHit).url)
          return
        }
        const list = (res as DocSearchListResult)?.items ?? []
        if (list.length === 1) {
          onResolved?.()
          navigate(list[0].url)
        } else if (list.length === 0) {
          onNotFound?.(`Code-barres ${v} : aucun document trouvé`)
        }
      } catch (e: any) {
        if (!cancelled) onNotFound?.(e?.message ?? `Code-barres ${v} introuvable`)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
}
