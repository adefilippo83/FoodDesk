import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { setMoneyLocale } from './api'

/**
 * Two languages and ~100 strings: a typed dictionary beats an i18n library.
 * `en` is the reference shape; `it` must provide every key or the compiler
 * complains, so translations can never silently go missing.
 */

const en = {
  // shell
  navNewOrder: 'New order',
  navOrders: 'Orders',
  navMenu: 'Menu',
  navStaff: 'Staff',
  navReports: 'Reports',
  roleAdmin: 'admin',
  roleWaiter: 'waiter',
  signOut: 'Sign out',
  loading: 'Loading…',

  // login
  loginTagline: 'Sign in to take orders.',
  username: 'Username',
  password: 'Password',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  errWrongCredentials: 'Wrong username or password.',
  errServerUnreachable: 'Could not reach the server. Check the Wi-Fi connection.',

  // new order
  loadingMenu: 'Loading menu…',
  errLoadMenu: 'Could not load the menu.',
  menuEmpty: 'The menu is empty.',
  menuEmptyHint: 'An admin needs to add categories and products first.',
  nothingInCategory: 'Nothing in {name} yet.',
  cartTitle: 'Order',
  table: 'Table',
  tablePlaceholder: 'e.g. 12 or Bar',
  tapToAdd: 'Tap a product to add it.',
  each: 'each',
  kitchenNote: 'Note for the kitchen',
  kitchenNotePlaceholder: 'e.g. no onion',
  total: 'Total',
  sendOrder: 'Send order',
  sending: 'Sending…',
  clear: 'Clear',
  orderSent: 'Order #{n} sent',
  errProductGone: 'Something in this order was just taken off the menu. Refresh and re-add it.',
  errSendOrder: 'Could not send the order. Check the connection and try again.',
  oneMore: 'One more {name}',
  oneLess: 'One less {name}',

  // orders
  ordersTitle: 'Orders',
  orderSingular: 'order',
  orderPlural: 'orders',
  showingOwnOrders: 'Showing the orders you took today.',
  noOrdersToday: 'No orders yet today.',
  errLoadOrders: 'Could not load orders.',
  colWaiter: 'Waiter',
  colTime: 'Time',
  colKitchen: 'Kitchen',
  view: 'View',
  receipt: 'Receipt',
  print: 'Print',
  reprint: 'Reprint',
  printing: 'Printing…',
  badgePrinted: 'printed',
  badgeFailed: 'failed',
  badgeNoPrinter: 'no printer',
  noPrinterTitle: 'No kitchen printer is configured on the server',
  errNoPrinter:
    'No kitchen printer is configured on the server — open the kitchen PDF and print it from the browser instead.',
  errReprintFailed: 'Reprint failed — check the kitchen printer.',
  notePrefix: 'Note:',
  receiptPdf: 'Receipt PDF',
  kitchenPdf: 'Kitchen PDF',
  close: 'Close',

  // admin menu
  categories: 'Categories',
  newCategoryPlaceholder: 'New category, e.g. Starters',
  add: 'Add',
  noCategories: 'No categories yet.',
  name: 'Name',
  products: 'Products',
  hidden: 'hidden',
  hide: 'Hide',
  restore: 'Restore',
  softDeleteHint:
    'Hiding a category also hides its products. Nothing is ever deleted outright, so past orders stay intact.',
  productNamePlaceholder: 'Product name',
  pricePlaceholder: '8.50',
  remove: 'Remove',
  noProducts: 'No products yet.',
  category: 'Category',
  price: 'Price',
  tapToChangePrice: 'Tap to change the price',
  errProductName: 'Give the product a name.',
  errPriceFormat: 'Price must look like 8 or 8.50.',
  errPickCategory: 'Pick a category.',
  errAddProduct: 'Could not add the product.',
  errAddCategory: 'Could not add the category.',
  errHideCategory: 'Could not hide the category.',
  errRestoreCategory: 'Could not restore the category.',
  errUpdatePrice: 'Could not update the price.',
  errRemoveProduct: 'Could not remove the product.',
  errRestoreProduct: 'Could not restore the product.',

  // staff
  addSomeone: 'Add someone',
  usernamePlaceholder: 'username',
  displayNamePlaceholder: 'Display name',
  passwordPlaceholder: 'password (8+ chars)',
  optionWaiter: 'Waiter',
  optionAdmin: 'Admin',
  staffHint:
    'Waiters can take and view their own orders. Admins can also change the menu, prices and staff.',
  role: 'Role',
  you: '(you)',
  disable: 'Disable',
  enable: 'Enable',
  cantDisableSelf: 'You cannot disable your own account',
  errLastAdmin: 'This is the last admin — promote someone else first.',
  errUsernameTaken: 'That username is already taken.',
  errCreateAccount: 'Could not create the account.',
  errUpdateAccount: 'Could not update the account.',
  errLoadStaff: 'Could not load staff.',
  errUsernameRequired: 'Username is required.',
  errPasswordShort: 'Password must be at least 8 characters.',

  // reports
  noReportsYet: 'No orders yet — reports appear after the first sale.',
  downloadCsv: 'Download CSV',
  revenue: 'Revenue',
  avgOrder: 'Average order',
  byProduct: 'By product',
  byCategory: 'By category',
  byWaiter: 'By waiter',
  qty: 'Qty',
  nothingSold: 'Nothing sold.',
  errLoadReportDays: 'Could not load report days.',
  errLoadReport: 'Could not load the report.',

  // new-order extras
  customer: 'Customer',
  customerPlaceholder: 'e.g. Mario',
  errCustomerRequired: 'Enter the customer name.',
  covers: 'Covers',
  coverCharge: 'Cover charge',

  // cancellation
  cancelOrder: 'Cancel order',
  confirmCancel: 'Sure?',
  cancelledBadge: 'cancelled',
  errCancelOrder: 'Could not cancel the order.',

  // password
  changePassword: 'Change password',
  currentPassword: 'Current password',
  newPassword: 'New password (8+ chars)',
  passwordChanged: 'Password changed',
  errWrongCurrentPassword: 'Current password is wrong.',
  errChangePassword: 'Could not change the password.',
  save: 'Save',
  cancel: 'Cancel',
  resetPassword: 'Reset password',
  passwordReset: 'Password updated',

  // menu extras
  dragToReorder: 'Drag ≡ to reorder. The order here is the order waiters see.',
  errReorder: 'Could not save the new order.',
  errMoveProduct: 'Could not move the product.',

  // settings
  navSettings: 'Settings',
  settingsGeneral: 'General',
  settingsPrint: 'Printing & layout',
  coverChargeAmount: 'Cover charge (per person)',
  paperSize: 'Paper size',
  paperRoll80: '80mm roll (thermal)',
  pdfLangLabel: 'Receipt language',
  headerTextLabel: 'Receipt header text',
  footerTextLabel: 'Receipt footer text',
  logoLabel: 'Logo',
  backgroundLabel: 'Background (watermark)',
  uploadImage: 'Upload image…',
  removeImage: 'Remove',
  previewReceipt: 'Preview receipt',
  settingsSaved: 'Settings saved',
  errSaveSettings: 'Could not save the settings.',
  errImageTooLarge: 'Image too large (max 700 KB, PNG or JPEG).',

  // reports extras
  coversStat: 'Covers',
  avgPerCover: 'Average per cover',
  cancelledStat: 'Cancelled',
  downloadPdf: 'Download PDF',
}

const it: typeof en = {
  navNewOrder: 'Nuovo ordine',
  navOrders: 'Ordini',
  navMenu: 'Menù',
  navStaff: 'Personale',
  navReports: 'Report',
  roleAdmin: 'admin',
  roleWaiter: 'cameriere',
  signOut: 'Esci',
  loading: 'Caricamento…',

  loginTagline: 'Accedi per prendere le ordinazioni.',
  username: 'Nome utente',
  password: 'Password',
  signIn: 'Accedi',
  signingIn: 'Accesso…',
  errWrongCredentials: 'Nome utente o password errati.',
  errServerUnreachable: 'Impossibile raggiungere il server. Controlla la connessione Wi-Fi.',

  loadingMenu: 'Caricamento menù…',
  errLoadMenu: 'Impossibile caricare il menù.',
  menuEmpty: 'Il menù è vuoto.',
  menuEmptyHint: 'Un amministratore deve prima aggiungere categorie e prodotti.',
  nothingInCategory: 'Ancora niente in {name}.',
  cartTitle: 'Ordine',
  table: 'Tavolo',
  tablePlaceholder: 'es. 12 o Bancone',
  tapToAdd: 'Tocca un prodotto per aggiungerlo.',
  each: 'cad.',
  kitchenNote: 'Nota per la cucina',
  kitchenNotePlaceholder: 'es. senza cipolla',
  total: 'Totale',
  sendOrder: 'Invia ordine',
  sending: 'Invio…',
  clear: 'Svuota',
  orderSent: 'Ordine #{n} inviato',
  errProductGone:
    "Un prodotto di quest'ordine è appena stato tolto dal menù. Aggiorna e aggiungilo di nuovo.",
  errSendOrder: "Impossibile inviare l'ordine. Controlla la connessione e riprova.",
  oneMore: 'Aggiungi un {name}',
  oneLess: 'Togli un {name}',

  ordersTitle: 'Ordini',
  orderSingular: 'ordine',
  orderPlural: 'ordini',
  showingOwnOrders: 'Questi sono gli ordini che hai preso oggi.',
  noOrdersToday: 'Nessun ordine oggi, per ora.',
  errLoadOrders: 'Impossibile caricare gli ordini.',
  colWaiter: 'Cameriere',
  colTime: 'Ora',
  colKitchen: 'Cucina',
  view: 'Vedi',
  receipt: 'Scontrino',
  print: 'Stampa',
  reprint: 'Ristampa',
  printing: 'Stampa…',
  badgePrinted: 'stampato',
  badgeFailed: 'errore',
  badgeNoPrinter: 'no stampante',
  noPrinterTitle: 'Nessuna stampante cucina configurata sul server',
  errNoPrinter:
    'Nessuna stampante cucina configurata sul server — apri il PDF cucina e stampalo dal browser.',
  errReprintFailed: 'Ristampa non riuscita — controlla la stampante della cucina.',
  notePrefix: 'Nota:',
  receiptPdf: 'PDF scontrino',
  kitchenPdf: 'PDF cucina',
  close: 'Chiudi',

  categories: 'Categorie',
  newCategoryPlaceholder: 'Nuova categoria, es. Antipasti',
  add: 'Aggiungi',
  noCategories: 'Nessuna categoria.',
  name: 'Nome',
  products: 'Prodotti',
  hidden: 'nascosto',
  hide: 'Nascondi',
  restore: 'Ripristina',
  softDeleteHint:
    'Nascondere una categoria nasconde anche i suoi prodotti. Niente viene mai eliminato del tutto: gli ordini passati restano intatti.',
  productNamePlaceholder: 'Nome prodotto',
  pricePlaceholder: '8,50',
  remove: 'Rimuovi',
  noProducts: 'Nessun prodotto.',
  category: 'Categoria',
  price: 'Prezzo',
  tapToChangePrice: 'Tocca per cambiare il prezzo',
  errProductName: 'Dai un nome al prodotto.',
  errPriceFormat: 'Il prezzo deve essere tipo 8 o 8,50.',
  errPickCategory: 'Scegli una categoria.',
  errAddProduct: 'Impossibile aggiungere il prodotto.',
  errAddCategory: 'Impossibile aggiungere la categoria.',
  errHideCategory: 'Impossibile nascondere la categoria.',
  errRestoreCategory: 'Impossibile ripristinare la categoria.',
  errUpdatePrice: 'Impossibile aggiornare il prezzo.',
  errRemoveProduct: 'Impossibile rimuovere il prodotto.',
  errRestoreProduct: 'Impossibile ripristinare il prodotto.',

  addSomeone: 'Aggiungi qualcuno',
  usernamePlaceholder: 'nome utente',
  displayNamePlaceholder: 'Nome visualizzato',
  passwordPlaceholder: 'password (min 8 caratteri)',
  optionWaiter: 'Cameriere',
  optionAdmin: 'Amministratore',
  staffHint:
    'I camerieri possono prendere e vedere i propri ordini. Gli amministratori possono anche modificare menù, prezzi e personale.',
  role: 'Ruolo',
  you: '(tu)',
  disable: 'Disattiva',
  enable: 'Attiva',
  cantDisableSelf: 'Non puoi disattivare il tuo account',
  errLastAdmin: "È l'ultimo amministratore — prima promuovi qualcun altro.",
  errUsernameTaken: 'Nome utente già in uso.',
  errCreateAccount: "Impossibile creare l'account.",
  errUpdateAccount: "Impossibile aggiornare l'account.",
  errLoadStaff: 'Impossibile caricare il personale.',
  errUsernameRequired: 'Il nome utente è obbligatorio.',
  errPasswordShort: 'La password deve avere almeno 8 caratteri.',

  noReportsYet: 'Ancora nessun ordine — i report compaiono dopo la prima vendita.',
  downloadCsv: 'Scarica CSV',
  revenue: 'Incasso',
  avgOrder: 'Ordine medio',
  byProduct: 'Per prodotto',
  byCategory: 'Per categoria',
  byWaiter: 'Per cameriere',
  qty: 'Q.tà',
  nothingSold: 'Nessuna vendita.',
  errLoadReportDays: 'Impossibile caricare i giorni.',
  errLoadReport: 'Impossibile caricare il report.',

  customer: 'Cliente',
  customerPlaceholder: 'es. Mario',
  errCustomerRequired: 'Inserisci il nome del cliente.',
  covers: 'Coperti',
  coverCharge: 'Coperto',

  cancelOrder: 'Annulla ordine',
  confirmCancel: 'Sicuro?',
  cancelledBadge: 'annullato',
  errCancelOrder: "Impossibile annullare l'ordine.",

  changePassword: 'Cambia password',
  currentPassword: 'Password attuale',
  newPassword: 'Nuova password (min 8 caratteri)',
  passwordChanged: 'Password cambiata',
  errWrongCurrentPassword: 'La password attuale è sbagliata.',
  errChangePassword: 'Impossibile cambiare la password.',
  save: 'Salva',
  cancel: 'Annulla',
  resetPassword: 'Reimposta password',
  passwordReset: 'Password aggiornata',

  dragToReorder: "Trascina ≡ per riordinare. L'ordine qui è quello che vedono i camerieri.",
  errReorder: 'Impossibile salvare il nuovo ordine.',
  errMoveProduct: 'Impossibile spostare il prodotto.',

  navSettings: 'Impostazioni',
  settingsGeneral: 'Generale',
  settingsPrint: 'Stampa e layout',
  coverChargeAmount: 'Coperto (a persona)',
  paperSize: 'Formato carta',
  paperRoll80: 'Rotolo 80mm (termica)',
  pdfLangLabel: 'Lingua scontrino',
  headerTextLabel: 'Intestazione scontrino',
  footerTextLabel: 'Piè di pagina scontrino',
  logoLabel: 'Logo',
  backgroundLabel: 'Sfondo (filigrana)',
  uploadImage: 'Carica immagine…',
  removeImage: 'Rimuovi',
  previewReceipt: 'Anteprima scontrino',
  settingsSaved: 'Impostazioni salvate',
  errSaveSettings: 'Impossibile salvare le impostazioni.',
  errImageTooLarge: 'Immagine troppo grande (max 700 KB, PNG o JPEG).',

  coversStat: 'Coperti',
  avgPerCover: 'Medio a coperto',
  cancelledStat: 'Annullati',
  downloadPdf: 'Scarica PDF',
}

export type Lang = 'en' | 'it'
export type StringKey = keyof typeof en
const dictionaries: Record<Lang, typeof en> = { en, it }

const STORAGE_KEY = 'fd_lang'

function initialLang(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'en' || stored === 'it') return stored
  return navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en'
}

type I18n = {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: StringKey, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18n | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const l = initialLang()
    setMoneyLocale(l === 'it' ? 'it-IT' : 'en-GB')
    return l
  })

  const setLang = useCallback((l: Lang) => {
    localStorage.setItem(STORAGE_KEY, l)
    setMoneyLocale(l === 'it' ? 'it-IT' : 'en-GB')
    setLangState(l)
  }, [])

  const t = useCallback(
    (key: StringKey, vars?: Record<string, string | number>) => {
      let s: string = dictionaries[lang][key]
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
      return s
    },
    [lang],
  )

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside LanguageProvider')
  return ctx
}

/** Compact IT/EN switch, shown in the top bar and on the login screen. */
export function LangToggle() {
  const { lang, setLang } = useI18n()
  const other: Lang = lang === 'it' ? 'en' : 'it'
  return (
    <button
      className="btn small lang-toggle"
      onClick={() => setLang(other)}
      title={other === 'it' ? 'Passa all’italiano' : 'Switch to English'}
    >
      {other.toUpperCase()}
    </button>
  )
}
