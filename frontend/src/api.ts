import type {
  User,
  Product,
  Supplier,
  Customer,
  Bulletin,
  StockResult,
  SupplierAdvance,
  Statement,
  ProductCategory,
  Unit,
  Sale,
  Invoice,
  Payment,
  CustomerStatement,
} from './types'

export const API = import.meta.env.VITE_API_URL ?? ''

export function getToken(): string | null {
  return localStorage.getItem('token')
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type UnauthorizedHandler = (() => void) | null
let unauthorizedHandler: UnauthorizedHandler = null
export function setUnauthorizedHandler(fn: UnauthorizedHandler) {
  unauthorizedHandler = fn
}

interface RequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>
  raw?: boolean
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  }
  if (!options.raw && options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${API}${path}`, { ...options, headers })

  if (res.status === 401) {
    localStorage.removeItem('token')
    unauthorizedHandler?.()
    throw new ApiError('Session expirée, veuillez vous reconnecter', 401)
  }

  if (!res.ok) {
    let msg = `Erreur ${res.status}`
    try {
      const d = (await res.json()) as { error?: string }
      if (d?.error) msg = d.error
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// ---- Auth ----
export function login(username: string, password: string) {
  return request<{ accessToken: string; tokenType?: string; expiresIn?: string; user?: User }>(
    '/api/auth/login',
    { method: 'POST', body: JSON.stringify({ username, password }) },
  )
}
export function logout() {
  return request('/api/auth/logout', { method: 'POST' })
}
export function getMe() {
  return request<User>('/api/auth/me')
}

// ---- Products ----
export function getProducts() {
  return request<{ items: Product[]; total: number }>('/api/products')
}
export function createProduct(data: Partial<Product>) {
  return request<Product>('/api/products', { method: 'POST', body: JSON.stringify(data) })
}
export function updateProduct(id: string, data: Partial<Product>) {
  return request<Product>(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}
export function deleteProduct(id: string) {
  return request<void>(`/api/products/${id}`, { method: 'DELETE' })
}

// ---- Product categories & units (for selects) ----
export function getProductCategories() {
  return request<{ items: ProductCategory[]; total: number } | ProductCategory[]>(
    '/api/product-categories',
  )
}
export function getUnits() {
  return request<{ items: Unit[]; total: number } | Unit[]>('/api/units')
}

// ---- Suppliers ----
export function getSuppliers() {
  return request<{ items: Supplier[]; total: number }>('/api/suppliers')
}
export function createSupplier(data: Partial<Supplier>) {
  return request<Supplier>('/api/suppliers', { method: 'POST', body: JSON.stringify(data) })
}
export function updateSupplier(id: string, data: Partial<Supplier>) {
  return request<Supplier>(`/api/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}
export function deleteSupplier(id: string) {
  return request<void>(`/api/suppliers/${id}`, { method: 'DELETE' })
}
export function getSupplierStatement(id: string) {
  return request<Statement>(`/api/suppliers/${id}/statement`)
}

// ---- Customers ----
export function getCustomers() {
  return request<{ items: Customer[]; total: number }>('/api/customers')
}
export function createCustomer(data: Partial<Customer>) {
  return request<Customer>('/api/customers', { method: 'POST', body: JSON.stringify(data) })
}
export function updateCustomer(id: string, data: Partial<Customer>) {
  return request<Customer>(`/api/customers/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}
export function deleteCustomer(id: string) {
  return request<void>(`/api/customers/${id}`, { method: 'DELETE' })
}

// ---- Search (autocomplete AR/FR) ----
export interface ProductSearchItem {
  id: string
  name: string
  nameAr?: string | null
  symbol?: string | null
  unit?: string | null
  quantity?: number | string | null
}
export function getProductSearch(q: string, supplierId?: string) {
  const params = new URLSearchParams({ q: q ?? '' })
  if (supplierId) params.set('supplierId', supplierId)
  return request<{ items: ProductSearchItem[] }>(
    `/api/products/search?${params.toString()}`,
  )
}

export interface CustomerSearchItem {
  id: string
  name: string
  nameAr?: string | null
  phone?: string | null
}
export function getCustomerSearch(q: string) {
  return request<{ items: CustomerSearchItem[] }>(
    `/api/customers/search?q=${encodeURIComponent(q ?? '')}`,
  )
}

// ---- Bulletins ----
export function getBulletins() {
  return request<Bulletin[]>('/api/bulletins')
}
export function getBulletin(id: string) {
  return request<Bulletin>(`/api/bulletins/${id}`)
}
export function createBulletin(data: { reference: string; supplierId: string; items: unknown[] }) {
  return request<Bulletin>('/api/bulletins', { method: 'POST', body: JSON.stringify(data) })
}
export function validateBulletin(id: string) {
  return request<Bulletin>(`/api/bulletins/${id}/validate`, { method: 'POST' })
}
export async function openBulletinPdf(id: string, format: 'a4' | 'a5' = 'a4'): Promise<void> {
  const token = getToken()
  const res = await fetch(`${API}/api/bulletins/${id}/pdf?format=${format}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new ApiError('Impossible de générer le PDF', res.status)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ---- Stock ----
export function getStock() {
  return request<StockResult>('/api/stock')
}
export function postStockLoss(data: { lotId: string; quantity: number | string; reason: string }) {
  return request<unknown>('/api/stock/loss', { method: 'POST', body: JSON.stringify(data) })
}

// ---- Stock lots (sélecteur Lot pour les ventes) ----
export interface StockLotItem {
  id: string
  lotNumber: string
  productId: string
  supplierId: string
  quantity: number | string
  remainingQuantity: number | string
  caliber?: string | null
  arrivalDate?: string
  product?: { id: string; name: string } | null
  supplier?: { id: string; name: string } | null
}
export function getStockLots(productId?: string, includeZero?: boolean) {
  const params = new URLSearchParams()
  if (productId) params.set('productId', productId)
  if (includeZero) params.set('includeZero', '1')
  const qs = params.toString() ? `?${params.toString()}` : ''
  return request<{ items: StockLotItem[]; total: number }>(`/api/stock-lots${qs}`)
}

// ---- Lot FIFO résolu (fournisseur+produit) pour la saisie de vente ----
export interface FifoLot {
  lotId: string
  lotNumber: string
  remainingQuantity: number | string
}
export function getFifoLot(supplierId: string, productId: string, calibre?: string) {
  const params = new URLSearchParams({ supplierId, productId })
  if (calibre) params.set('calibre', calibre)
  return request<{ lot: FifoLot | null }>(`/api/stock-lots/fifo?${params.toString()}`)
}

// ---- Supplier bordereaux (Étape 2/3) ----
export function getSupplierBordereau(id: string) {
  return request<any>(`/api/supplier-bordereaux/${id}`)
}
export function getSupplierBordereaux() {
  return request<{ items: any[]; total: number }>('/api/supplier-bordereaux')
}
export function updateSupplierBordereau(
  id: string,
  data: {
    commissionType?: 'pourcentage' | 'fixe'
    commissionValue?: number | string
    statut?: string
    notes?: string | null
  },
) {
  return request<any>(`/api/supplier-bordereaux/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
export function affectAdvanceToBordereau(id: string, data: { advanceId: string; amount: number | string }) {
  return request<any>(`/api/supplier-bordereaux/${id}/avances`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
export function clotureBordereau(id: string) {
  return request<any>(`/api/supplier-bordereaux/${id}/cloture`, { method: 'PATCH' })
}
export function correctBordereau(
  id: string,
  data: { motif: string; commissionType?: string; commissionValue?: number | string; avancesAffectees?: number | string },
) {
  return request<any>(`/api/supplier-bordereaux/${id}/correct`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
export async function openBordereauPdf(id: string): Promise<void> {
  const token = getToken()
  const res = await fetch(`${API}/api/supplier-bordereaux/${id}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    let bodyOuMessage = ''
    try {
      const text = await res.text()
      try {
        const json = JSON.parse(text)
        bodyOuMessage = json?.message || json?.error || text
      } catch {
        bodyOuMessage = text
      }
    } catch {
      bodyOuMessage = res.statusText
    }
    throw new ApiError(`PDF échec (${res.status}): ${bodyOuMessage}`, res.status)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Ouvre le PDF A5 « Bordereau de caisse » d'une journée (YYYY-MM-DD). */
export async function openCashDayPdf(date: string): Promise<void> {
  const token = getToken()
  const res = await fetch(`${API}/api/cash-register/days/${date}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    let bodyOuMessage = ''
    try {
      const text = await res.text()
      try {
        const json = JSON.parse(text)
        bodyOuMessage = json?.message || json?.error || text
      } catch {
        bodyOuMessage = text
      }
    } catch {
      bodyOuMessage = res.statusText
    }
    throw new ApiError(`PDF échec (${res.status}): ${bodyOuMessage}`, res.status)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ---- Supplier advances ----
export function getAdvances() {
  return request<SupplierAdvance[]>('/api/supplier-advances')
}
export function createAdvance(data: {
  supplierId: string
  amount: number | string
  paymentMethod?: string
  reference?: string
  notes?: string
}) {
  return request<SupplierAdvance>('/api/supplier-advances', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
export function allocateAdvance(id: string, data: { purchaseBulletinId: string; amount: number | string }) {
  return request<SupplierAdvance>(`/api/supplier-advances/${id}/allocate`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

// ---- Sales (Phase C) ----
export function getSales() {
  return request<Sale[] | { items: Sale[]; total: number }>('/api/sales')
}
export function getSale(id: string) {
  return request<Sale>(`/api/sales/${id}`)
}
export function createSale(data: {
  customerId?: string | null
  customerName?: string | null
  supplierId?: string | null
  items: {
    productId: string
    supplierId?: string | null
    caliber?: string | null
    lotId?: string | null
    quantity?: number | string
    colis?: number | string | null
    grossWeight?: number | string | null
    tare?: number | string | null
    netWeight?: number | string | null
    unitPrice: number | string
    packingUnitPrice?: number | string | null
  }[]
}) {
  return request<{ id: string; reference: string }>('/api/sales', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
export function confirmSale(id: string) {
  return request<{ status: string }>(`/api/sales/${id}/confirm`, { method: 'POST' })
}

// ---- Invoices (Phase C) ----
export function getInvoices() {
  return request<Invoice[] | { items: Invoice[]; total: number }>('/api/invoices')
}
export function createInvoice(data: {
  saleId?: string | null
  customerId?: string | null
  customerName?: string | null
  packingReturned?: boolean
  items?: {
    productId?: string
    description?: string
    quantity: number | string
    unitPrice: number | string
    packingUnitPrice?: number | string
    colis?: number | string
    grossWeight?: number | string
    tare?: number | string
    netWeight?: number | string
  }[]
}) {
  return request<{ id: string; reference: string }>('/api/invoices', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
export function updateInvoice(
  id: string,
  data: {
    issueDate?: string
    notes?: string
    packingReturned?: boolean
    items?: {
      description?: string
      productId?: string
      quantity: number | string
      unitPrice: number | string
      packingUnitPrice?: number | string
      colis?: number | string
      grossWeight?: number | string
      tare?: number | string
      netWeight?: number | string
    }[]
  },
) {
  return request<Invoice>(`/api/invoices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
export function deleteInvoice(id: string) {
  return request<{ id: string }>(`/api/invoices/${id}`, { method: 'DELETE' })
}
export function deleteSale(id: string) {
  return request<{ id: string }>(`/api/sales/${id}`, { method: 'DELETE' })
}
export function issueInvoice(id: string) {
  return request<{ status: string }>(`/api/invoices/${id}/issue`, { method: 'POST' })
}
export function getInvoice(id: string) {
  return request<Invoice>(`/api/invoices/${id}`)
}
export async function openInvoicePdf(id: string): Promise<void> {
  const token = getToken()
  const res = await fetch(`${API}/api/invoices/${id}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new ApiError('Impossible de générer le PDF', res.status)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ---- Payments (Phase C) ----
export function getPayments() {
  return request<Payment[] | { items: Payment[]; total: number }>('/api/payments')
}
export function createPayment(data: {
  customerId?: string | null
  invoiceId?: string | null
  saleId?: string | null
  amount: number | string
  method: 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD'
  notes?: string | null
}) {
  return request<{ id: string }>('/api/payments', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
export function getCustomerStatement(id: string) {
  return request<CustomerStatement>(`/api/customers/${id}/statement`)
}

// ---- Supplier receptions (Bon de réception) ----
export interface SupplierReception {
  id: string
  reference: string
  date: string
  heure?: string | null
  supplierId: string
  productId: string
  nbrColis: string
  poidsEmballageVide: string
  avanceOui: boolean
  avanceMontant: string
  droitMarche?: string
  transport?: string
  observations?: string | null
  bordereauId?: string | null
  lotId?: string | null
  bordereau?: { reference: string; statut?: string; calibre?: string | null } | null
  lot?: { lotNumber: string } | null
}
export function getReceptions() {
  return request<{ items: SupplierReception[]; total: number }>('/api/supplier-receptions')
}
export interface SupplierReceptionDetail extends SupplierReception {
  items?: { id: string; calibre?: string | null; nbrColis: string; poidsEmballageVide: string; lotId?: string | null }[]
  bordereau?: (SupplierReception['bordereau'] & {
    id?: string
    colisRecus?: string
    totalBrutVentes?: string
    commissionType?: string
    commissionValue?: string
    avancesAffectees?: string
    droitMarche?: string
    transport?: string
    montantFinalDu?: string
  }) | null
  lot?: { id?: string; lotNumber: string } | null
}
export function getReception(id: string) {
  return request<SupplierReceptionDetail>(`/api/supplier-receptions/${id}`)
}
export function createReception(data: {
  supplierId: string
  productId: string
  items: { calibre?: string; nbrColis: number; poidsEmballageVide: number }[]
  avanceOui: boolean
  avanceMontant: number
  droitMarche?: number
  transport?: number
  observations?: string | null
}) {
  return request<SupplierReception>('/api/supplier-receptions', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
export function updateReception(
  id: string,
  data: {
    observations?: string | null
    avanceOui?: boolean
    avanceMontant?: number
    poidsEmballageVide?: number
    nbrColis?: number
    items?: { calibre?: string; nbrColis: number; poidsEmballageVide?: number }[]
    droitMarche?: number
    transport?: number
  },
) {
  return request<SupplierReception>(`/api/supplier-receptions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
export async function openReceptionPdf(id: string): Promise<void> {
  const token = getToken()
  const res = await fetch(`${API}/api/supplier-receptions/${id}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    let bodyOuMessage = ''
    try {
      const text = await res.text()
      try {
        const json = JSON.parse(text)
        bodyOuMessage = json?.message || json?.error || text
      } catch {
        bodyOuMessage = text
      }
    } catch {
      bodyOuMessage = res.statusText
    }
    throw new ApiError(`PDF échec (${res.status}): ${bodyOuMessage}`, res.status)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// =====================================================================
// MODULE CAISSE (Temps 1)
// =====================================================================
export interface CashDay {
  id: string
  date: string
  openingCashFund: string
  invoiceTotal: string
  creditCollectionTotal: string
  cashSupplyTotal: string
  totalEntries: string
  creditInvoiceTotal: string
  unpaidPartialInvoiceTotal: string
  expenseTotal: string
  cashRemittanceTotal: string
  closingCashFund: string
  totalOutputs: string
  difference: string
  status: string
  closedBy?: string | null
  closedAt?: string | null
}

export interface CashEntry {
  id: string
  direction: 'ENTRY' | 'OUTPUT'
  category: string
  amount: string
  sourceType: string
  sourceId?: string | null
  reference?: string | null
  description?: string | null
  createdBy?: string | null
  createdAt?: string
  virtuel: boolean
  deduction: boolean
}

export interface CashTotaux {
  openingCashFund: string
  invoiceTotal: string
  creditCollectionTotal: string
  cashSupplyTotal: string
  autresEntrees: string
  totalEntries: string
  creditInvoiceTotal: string
  unpaidPartialInvoiceTotal: string
  expenseTotal: string
  cashRemittanceTotal: string
  closingCashFund: string
  autresSorties: string
  totalOutputs: string
  difference: string
  encaissementReelVentes: string
}

export interface CashDayDetail {
  date: string
  day: CashDay | null
  status: string
  closedBy?: string | null
  closedAt?: string | null
  entries: CashEntry[]
  outputs: CashEntry[]
  totaux: CashTotaux
}

export interface Expense {
  id: string
  date: string
  heure?: string | null
  motif: string
  category?: string | null
  amount: string
  paymentMethod: string
  observation?: string | null
  justificatif?: string | null
  userId?: string | null
  status: string
}

export interface CashSupply {
  id: string
  reference: string
  date: string
  heure?: string | null
  amount: string
  motif: string
  mode: string
  observation?: string | null
}

export interface CashRemittance {
  id: string
  reference: string
  date: string
  heure?: string | null
  amount: string
  beneficiary?: string | null
  motif: string
  observation?: string | null
}

/** Liste des journées de caisse (date desc). */
export function getCashDays() {
  return request<{ items: CashDay[]; total: number }>('/api/cash-register/days')
}

/** Détail d'une journée de caisse (YYYY-MM-DD), totaux recalculés à la volée. */
export function getCashDay(date: string) {
  return request<CashDayDetail>(`/api/cash-register/days/${date}`)
}

/** Liste des dépenses (filtre date optionnel). */
export function getExpenses(date?: string) {
  const qs = date ? `?date=${date}` : ''
  return request<{ items: Expense[]; total: number }>(`/api/cash-register/expenses${qs}`)
}

/** Création d'une dépense (génère une sortie de caisse). */
export function createExpense(data: {
  date?: string
  heure?: string
  motif: string
  category?: string | null
  amount: number | string
  paymentMethod?: string
  observation?: string | null
  justificatif?: string | null
}) {
  return request<{ expense: Expense; entry: CashEntry }>('/api/cash-register/expenses', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/** Annulation d'une dépense (ligne inverse en caisse, pas de suppression). */
export function cancelExpense(id: string) {
  return request<{ expense: Expense; entry: CashEntry }>(
    `/api/cash-register/expenses/${id}/cancel`,
    { method: 'PATCH' },
  )
}

/** Liste des approvisionnements (filtre date optionnel). */
export function getSupplies(date?: string) {
  const qs = date ? `?date=${date}` : ''
  return request<{ items: CashSupply[]; total: number }>(`/api/cash-register/supplies${qs}`)
}

/** Création d'un approvisionnement de caisse (entrée). */
export function createSupply(data: {
  date?: string
  heure?: string
  amount: number | string
  motif: string
  mode?: string
  observation?: string | null
}) {
  return request<{ supply: CashSupply; entry: CashEntry }>('/api/cash-register/supplies', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/** Liste des remises (filtre date optionnel). */
export function getRemittances(date?: string) {
  const qs = date ? `?date=${date}` : ''
  return request<{ items: CashRemittance[]; total: number }>(`/api/cash-register/remittances${qs}`)
}

/** Création d'une remise d'espèces (sortie). */
export function createRemittance(data: {
  date?: string
  heure?: string
  amount: number | string
  beneficiary?: string | null
  motif: string
  observation?: string | null
}) {
  return request<{ remittance: CashRemittance; entry: CashEntry }>(
    '/api/cash-register/remittances',
    { method: 'POST', body: JSON.stringify(data) },
  )
}

/** Clôture d'une journée de caisse. */
export function closeCashDay(date: string, data: { closingCashFund: number | string; userId?: string }) {
  return request<{ day: CashDay; closing: Record<string, string>; totaux: CashTotaux }>(
    `/api/cash-register/days/${date}/close`,
    { method: 'PATCH', body: JSON.stringify(data) },
  )
}

// ---- Drill-down des synthèses de caisse (/caisse/:date -> listes) ----
export interface CashDayInvoice {
  id: string
  reference: string
  customerName?: string | null
  total: string
  status: string
  issueDate: string
}
export interface CashDayCreditCollection {
  id: string
  reference: string
  invoiceId?: string | null
  invoiceReference?: string | null
  invoiceTotal?: string | null
  customerName?: string | null
  amount: string
  method: string
  paymentDate: string
}
export interface CashDayExpense {
  id: string
  motif: string
  category?: string | null
  amount: string
  paymentMethod: string
  heure?: string | null
  userId?: string | null
  status: string
  date: string
}
export interface CashDayRemittance {
  id: string
  reference: string
  amount: string
  beneficiary?: string | null
  motif: string
  heure?: string | null
  date: string
}
export interface CashDayList<T> {
  date: string
  items: T[]
  total: number
}

/** Factures émises le jour donné (statuts comptabilisés). */
export function getCashDayInvoices(date: string) {
  return request<CashDayList<CashDayInvoice>>(`/api/cash-register/days/${date}/invoices`)
}
/** Encaissements de crédits clients du jour. */
export function getCashDayCreditCollections(date: string) {
  return request<CashDayList<CashDayCreditCollection>>(
    `/api/cash-register/days/${date}/credit-collections`,
  )
}
/** Dépenses du jour. */
export function getCashDayExpenses(date: string) {
  return request<CashDayList<CashDayExpense>>(`/api/cash-register/days/${date}/expenses`)
}
/** Factures à crédit créées le jour (ventes à crédit). */
export function getCashDayCreditSales(date: string) {
  return request<CashDayList<CashDayInvoice>>(`/api/cash-register/days/${date}/credit-sales`)
}
/** Remises d'espèces du jour. */
export function getCashDayRemittances(date: string) {
  return request<CashDayList<CashDayRemittance>>(`/api/cash-register/days/${date}/remittances`)
}

// ---- Recherche globale documents (code-barres EAN13 / texte) ----
// Le lecteur code-barres USB saisit comme un clavier : dès qu'un EAN13
// (13 chiffres) est saisi dans une barre de recherche, on appelle cet
// endpoint et on redirige vers le document.
export type DocSearchType = 'invoice' | 'reception' | 'bordereau'
export interface DocSearchHit {
  type: DocSearchType
  id: string
  reference: string
  label?: string
  url: string
}
export interface DocSearchListResult {
  items: DocSearchHit[]
  total: number
}
/** GET /api/search?q=... — renvoie un document unique (EAN13) ou une liste (texte). */
export function searchByQuery(q: string) {
  return request<DocSearchHit | DocSearchListResult>(
    `/api/search?q=${encodeURIComponent(q ?? '')}`,
  )
}

// =====================================================================
// PAIEMENT FOURNISSEUR (bons BP-xxxx)
// =====================================================================
export interface SupplierPaymentRow {
  id: string
  reference: string
  date: string
  supplierId: string
  supplierName: string
  totalAmount: string
  mode: string
  method: string
  status?: string
  ean13?: string | null
}
export interface EligibleBordereau {
  id: string
  reference: string
  receptionId?: string | null
  receptionRef?: string | null
  dateCloture: string | null
  montantFinalDu: string
  statut: string
}
export interface SupplierPaymentDetailDTO {
  id: string
  reference: string
  ean13?: string | null
  date: string
  mode: string
  method: string
  totalAmount: string
  status?: string
  notes?: string | null
  supplier?: { id: string; name: string; phone?: string | null; wilaya?: string | null } | null
  lines: {
    id: string
    bordereauId: string
    bordereauRef: string
    receptionRef?: string | null
    productName?: string | null
    dateCloture: string | null
    statut: string | null
    montant: string
    montantDuAvant?: string | null
    montantPaye?: string | null
    reste: string | null
  }[]
}

export function listSupplierPayments() {
  return request<{ items: SupplierPaymentRow[]; total: number }>('/api/supplier-payments')
}
export function getEligibleBordereaux(supplierId: string) {
  return request<{ items: EligibleBordereau[]; total: number }>(
    `/api/supplier-payments/eligible/${supplierId}`,
  )
}
export function createSupplierPayment(payload: {
  supplierId: string
  date?: string
  mode: 'PAY' | 'ENCAISSER'
  method?: 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD'
  notes?: string | null
  lines: { bordereauId: string; montant: number | string }[]
}) {
  return request<{ payment: SupplierPaymentRow; lines: unknown[] }>('/api/supplier-payments', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
export function getSupplierPayment(id: string) {
  return request<SupplierPaymentDetailDTO>(`/api/supplier-payments/${id}`)
}
export function paySupplierPayment(
  id: string,
  payload: {
    mode: 'PAY' | 'ENCAISSER'
    method?: 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD'
    date?: string
    lines: { bordereauId: string; montant: number | string }[]
  },
) {
  return request<{ payment: SupplierPaymentRow; lines: unknown[] }>(
    `/api/supplier-payments/${id}/pay`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
}
export async function openSupplierPaymentPdf(id: string): Promise<void> {
  const token = getToken()
  const res = await fetch(`${API}/api/supplier-payments/${id}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new ApiError(`PDF échec (${res.status})`, res.status)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
