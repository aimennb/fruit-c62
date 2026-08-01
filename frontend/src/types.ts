export interface User {
  id: string
  username: string
  email?: string
  fullName: string
  role: string
  isActive?: boolean
  permissions?: string[]
  createdAt?: string
  updatedAt?: string
}

export interface Product {
  id: string
  name: string
  nameAr?: string | null
  nameBer?: string | null
  variety?: string | null
  origin?: string | null
  quality?: string | null
  calibre?: string | null
  sku?: string | null
  barcode?: string | null
  packaging?: string | null
  description?: string | null
  avgPurchasePrice?: string | null
  lastPurchasePrice?: string | null
  suggestedSalePrice?: string | null
  alertThreshold?: string | null
  initialQuantity?: number | string | null
  notes?: string | null
  isActive?: boolean
  reorderLevel?: string | null
  categoryId?: string | null
  unitId?: string | null
  category?: { id: string; name: string } | null
  unit?: { id: string; name: string; symbol?: string | null } | null
  quantity?: number | null
  suppliers?: ProductSupplier[] | null
  supplierIds?: string[]
  createdAt?: string
  updatedAt?: string
}

export interface ProductSupplier {
  id: string
  name: string
  nameAr?: string | null
  isPreferred?: boolean
}

export interface ProductCategory {
  id: string
  name: string
  nameAr?: string | null
  description?: string | null
  isActive?: boolean
}

export interface Unit {
  id: string
  name: string
  nameAr?: string | null
  symbol?: string | null
  isActive?: boolean
}

export interface Supplier {
  id: string
  name: string
  nameAr?: string | null
  contactName?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
  commune?: string | null
  wilaya?: string | null
  country?: string | null
  rc?: string | null
  nif?: string | null
  ai?: string | null
  notes?: string | null
  isActive?: boolean
  balance?: string
  createdAt?: string
  updatedAt?: string
}

export interface Customer {
  id: string
  name: string
  nameAr?: string | null
  contactName?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
  commune?: string | null
  wilaya?: string | null
  nif?: string | null
  creditLimit?: string
  paymentTerms?: string | null
  notes?: string | null
  isActive?: boolean
  balance?: string
  createdAt?: string
  updatedAt?: string
}

export interface BulletinItem {
  id?: string
  productId: string
  productName?: string
  marque?: string | null
  nbrColis: string
  poidsBrut: string
  tare: string
  poidsNet?: string
  prixUnitaire: string
  montant?: string
}

export interface Bulletin {
  id: string
  reference: string
  purchaseId?: string | null
  date?: string
  status: string
  deliveredTo?: string | null
  marque?: string | null
  emballage?: string | null
  consigne?: string | null
  carrier?: string | null
  notes?: string | null
  totalWeight?: string
  totalAmount?: string
  items: BulletinItem[]
}

export interface StockProduct {
  productId: string
  name: string
  sku?: string | null
  quantity: string
  value: string
  reorderLevel?: string | null
  lotCount: number
  alert: string
}

export interface StockLot {
  lotId: string
  lotNumber: string
  productId: string
  productName: string
  supplierId?: string | null
  supplierName?: string | null
  bordereauId?: string | null
  bordereauRef?: string | null
  quantity: string
  unitCost?: string
  grossWeight?: string
  tare?: string
  netWeight?: string
  origin?: string | null
  quality?: string | null
  caliber?: string | null
  arrivalDate?: string
  value?: string
  reorderLevel?: string | null
}

export interface StockResult {
  totalValue: string
  products: StockProduct[]
  lots: StockLot[]
}

export interface SupplierAdvance {
  id: string
  supplierId: string
  reference?: string
  amount: string
  allocatedAmount?: string
  refundedAmount?: string
  advanceDate?: string
  status?: string
  paymentMethod?: string | null
  notes?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface Statement {
  supplier: Supplier
  balance: string
  accountSummary: Record<string, unknown>
  entries: unknown[]
  advances: SupplierAdvance[]
  recentPurchases: unknown[]
}

// ---- Phase C: Sales / Invoices / Payments ----

export type SaleStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED'
export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PAID' | 'CANCELLED'
export type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CHECK' | 'CARD'

export interface SaleItem {
  id?: string
  productId?: string
  lotId?: string | null
  product?: { id: string; name: string } | null
  name?: string
  quantity?: number | string
  colis?: number | string | null
  grossWeight?: number | string | null
  tare?: number | string | null
  netWeight?: number | string | null
  unitPrice: number | string
  packingUnitPrice?: number | string | null
  total?: number | string
}

export interface Sale {
  id: string
  reference: string
  customer?: { id: string; name: string } | null
  customerId?: string | null
  supplier?: { id: string; name: string } | null
  supplierId?: string | null
  status: SaleStatus
  total: number | string
  items: SaleItem[]
  createdAt?: string
  updatedAt?: string
}

export interface InvoiceItem {
  id?: string
  productId?: string
  product?: { id: string; name: string } | null
  name?: string
  caliber?: string | null
  quantity?: number | string
  colis?: number | string | null
  grossWeight?: number | string | null
  tare?: number | string | null
  netWeight?: number | string | null
  unitPrice: number | string
  packingUnitPrice?: number | string | null
  total?: number | string
}

export interface Invoice {
  id: string
  reference: string
  customer?: { id: string; name: string } | null
  customerId?: string | null
  status: InvoiceStatus
  total: number | string
  issueDate?: string | null
  dueDate?: string | null
  saleId?: string | null
  items?: InvoiceItem[]
  paidAmount?: number | string
  remaining?: number | string
  packingTotal?: number | string
  packingReturned?: boolean
  createdAt?: string
  updatedAt?: string
  payments?: Array<{
    id: string
    reference: string
    amount: string | number
    method?: string
    paymentDate?: string | null
    notes?: string | null
    saleId?: string | null
  }>
}

export interface Payment {
  id: string
  reference: string
  customer?: { id: string; name: string } | null
  customerId?: string | null
  invoice?: { id: string; reference: string } | null
  invoiceId?: string | null
  saleId?: string | null
  amount: number | string
  method: PaymentMethod
  paymentDate?: string | null
  notes?: string | null
  createdAt?: string
}

export interface CustomerStatement {
  id: string
  name: string
  balance: string | number
  creditLimit: string | number
  exceeded: boolean
  sales: Sale[]
  invoices: Invoice[]
  payments: Payment[]
}
