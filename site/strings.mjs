/**
 * Landing-page copy, one entry per language the app ships. English is the
 * reference: build.mjs fails the build if any language misses a key.
 */

export const en = {
  langName: 'English',
  title: 'FoodDesk — open-source ordering for food festivals',
  metaDescription:
    'The open-source ordering system for food festivals, pop-up restaurants and community kitchens. Waiters order from their phones, the kitchen ticks off dishes on a tablet, tickets print themselves. No cloud, no fees.',
  navFeatures: 'Features',
  navHow: 'How it works',
  navRun: 'Run it',
  heroTitle: 'The paper pads are gone. <em>The line moves faster.</em>',
  heroLede:
    'FoodDesk is the open-source ordering system for food festivals, pop-up restaurants and community kitchens. Waiters take orders on their phones, the kitchen ticks off dishes on a tablet, tickets print themselves — and at the end of the night the numbers are already added up. No cloud, no subscription, no per-order fees.',
  ctaDemo: 'Try the live demo',
  ctaRun: 'Run it yourself',
  demoCreds:
    'Demo accounts: <code>mario</code> (waiter), <code>cucina</code> (kitchen), <code>admin</code> — password <code>fooddesk-demo</code>. Open it on two devices — send an order from one and watch it appear on the other instantly.',
  featuresTitle: 'Built for the whole crew',
  featuresLede: 'Every role gets exactly the screen it needs — and nothing it does not.',
  fWaitersT: 'Waiters',
  fWaitersP:
    'A phone-first PWA: tap products, count covers, add kitchen notes, send. Orders are numbered per service day, and a network hiccup can never create a duplicate order.',
  fKitchenT: 'The kitchen',
  fKitchenP:
    'New orders appear the moment they are sent — no refreshing. Each dish is one big tap to mark done, and a cancelled order shouts CANCELLED instead of silently vanishing.',
  fMaitreT: "The maître d'",
  fMaitreP:
    'Runs the room with almost-admin powers: the menu, every order, cancellations and reports — but no settings page, and staff management limited to waiter accounts.',
  fAdminT: 'The admin',
  fAdminP:
    'Builds the menu, manages staff and roles, and styles every printed document from the browser — logo, watermark, paper size, 80mm thermal roll included — in five languages.',
  fReportsT: 'The treasurer',
  fReportsP:
    'A live daily dashboard: revenue, covers, average per cover, per-product and per-category breakdowns — plus clean CSV and a one-page PDF report.',
  fPrintT: 'Printing',
  fPrintP:
    "Kitchen tickets go straight to any CUPS printer with automatic retry when it jams; without a printer, the browser's print dialog steps in.",
  shotsTitle: 'See it in action',
  shotsLede: 'A sample festival evening on the live demo — reset every 6 hours.',
  shotPhoneAlt: "Taking an order on a waiter's phone",
  shotKitchenAlt: 'Kitchen display with live orders',
  shotKitchenCap: 'The kitchen display: one big tap per dish, orders complete themselves.',
  shotReportsAlt: 'End-of-day report dashboard',
  shotReportsCap: 'End-of-day reports: revenue, covers and breakdowns, ready to export.',
  howTitle: 'A night at the venue',
  howLede:
    'Everything runs on one inexpensive box — a mini-PC or Raspberry-class board — on the venue Wi-Fi. Phones install FoodDesk like a native app straight from the browser.',
  flowPhones: "Waiters' phones",
  flowPhonesSub: 'PWA on the venue Wi-Fi',
  flowTablet: 'Kitchen tablet',
  flowTabletSub: 'live updates, no refresh',
  flowBox: 'One small box',
  flowPrinter: 'Printer',
  howOutro:
    'The database is a single SQLite file, backed up automatically every 15 minutes. An order taken at 1:30 AM still counts for tonight — restaurants do not end at midnight.',
  runTitle: 'Run it',
  runLede: 'One command with Docker. The generated admin password is printed on first start.',
  copyBtn: 'Copy',
  copiedBtn: 'Copied!',
  dockerLogsComment: 'the admin password is printed on first start',
  runPi:
    '<strong>Raspberry Pi?</strong> Every <a href="https://github.com/adefilippo83/FoodDesk/releases">release</a> ships a ready-made image: flash it, power on, join the FoodDesk Wi-Fi it creates and start taking orders — no internet needed, USB printers configure themselves. <a href="https://github.com/adefilippo83/FoodDesk/blob/main/rpi/README.md">Guide</a>.',
  runAlts:
    'Prefer a venue server? <a href="https://github.com/adefilippo83/FoodDesk/blob/main/deploy/README.md">One idempotent install script</a> sets up systemd, nginx and backups on Debian. Or open it in <a href="https://codespaces.new/adefilippo83/FoodDesk">GitHub Codespaces</a> for a throwaway instance.',
  principlesTitle: 'Principles the code actually enforces',
  principlesLede: 'TypeScript end to end · Fastify · SQLite · React 19 PWA · GPLv3.',
  pMoneyT: 'Money is integer cents',
  pMoneyP: 'no floats in the money path, and prices always come from the database — a tampered client cannot discount.',
  pHistoryT: 'History is immutable',
  pHistoryP: 'order lines snapshot name and price; cancellations are audited, never erased. Yesterday’s receipts survive today’s menu edits.',
  pAuthT: 'Authorization lives on the server',
  pAuthP: 'every route is guarded; the UI hiding admin screens is cosmetic and the test suite is the real contract.',
  pHardenedT: 'Hardened by default',
  pHardenedP: 'scrypt passwords, login lockout, CSP and security headers, Origin checks on writes, idempotent order submission.',
  footerLicense: 'Free software under GPLv3.',
  footerReleases: 'Releases',
  footerDemo: 'Live demo',
}

export const it = {
  langName: 'Italiano',
  title: 'FoodDesk — il gestionale open source per sagre',
  metaDescription:
    'Il gestionale open source per sagre, feste di paese e ristoranti temporanei. I camerieri ordinano dal telefono, la cucina spunta i piatti sul tablet, i ticket si stampano da soli. Niente cloud, niente commissioni.',
  navFeatures: 'Funzioni',
  navHow: 'Come funziona',
  navRun: 'Installalo',
  heroTitle: 'Via i blocchetti di carta. <em>La fila scorre più veloce.</em>',
  heroLede:
    'FoodDesk è il gestionale open source per sagre, feste di paese e ristoranti temporanei. I camerieri prendono le comande dal telefono, la cucina spunta i piatti su un tablet, i ticket si stampano da soli — e a fine serata i conti sono già fatti. Niente cloud, niente abbonamenti, niente commissioni per ordine.',
  ctaDemo: 'Prova la demo live',
  ctaRun: 'Installalo subito',
  demoCreds:
    'Account demo: <code>mario</code> (cameriere), <code>cucina</code> (display cucina), <code>admin</code> — password <code>fooddesk-demo</code>. Aprila su due dispositivi: invia un ordine da uno e guardalo comparire all’istante sull’altro.',
  featuresTitle: 'Pensato per tutta la squadra',
  featuresLede: 'Ogni ruolo ha esattamente lo schermo che gli serve — e niente di più.',
  fWaitersT: 'I camerieri',
  fWaitersP:
    'Una PWA nata per il telefono: tocchi i prodotti, conti i coperti, aggiungi la nota per la cucina, invii. Gli ordini sono numerati per giornata di servizio e un singhiozzo di rete non può mai creare un doppione.',
  fKitchenT: 'La cucina',
  fKitchenP:
    'Gli ordini nuovi compaiono nell’istante in cui vengono inviati, senza ricaricare. Ogni piatto si segna pronto con un solo tap, e un ordine annullato grida ANNULLATO invece di sparire in silenzio.',
  fMaitreT: 'Il caposala',
  fMaitreP:
    'Governa la sala con poteri quasi da amministratore: menù, tutti gli ordini, annullamenti e report — ma niente pagina Impostazioni, e sul personale gestisce solo i camerieri.',
  fAdminT: 'L’amministratore',
  fAdminP:
    'Costruisce il menù, gestisce personale e ruoli, e disegna dal browser ogni documento stampato — logo, filigrana, formato carta, rotolo termico 80mm compreso — in cinque lingue.',
  fReportsT: 'Chi fa i conti',
  fReportsP:
    'Dashboard giornaliera in tempo reale: incasso, coperti, medio a coperto, dettaglio per prodotto e categoria — più CSV pulito e report PDF in una pagina.',
  fPrintT: 'La stampa',
  fPrintP:
    'I ticket cucina vanno dritti a qualunque stampante CUPS, con ristampa automatica se la stampante si inceppa; senza stampante subentra la finestra di stampa del browser.',
  shotsTitle: 'Guardalo in azione',
  shotsLede: 'La demo live carica una serata di sagra d’esempio, azzerata ogni 6 ore.',
  shotPhoneAlt: 'Comanda presa dal telefono del cameriere',
  shotKitchenAlt: 'Display cucina con gli ordini in tempo reale',
  shotKitchenCap: 'Il display cucina: un tap grande per piatto, gli ordini si completano da soli.',
  shotReportsAlt: 'Dashboard dei report di fine giornata',
  shotReportsCap: 'I report di fine giornata: incasso, coperti e dettagli, pronti da esportare.',
  howTitle: 'Una serata alla sagra',
  howLede:
    'Tutto gira su una sola macchina economica — un mini-PC o una scheda classe Raspberry — sul Wi-Fi della festa. I telefoni installano FoodDesk come un’app nativa direttamente dal browser.',
  flowPhones: 'Telefoni dei camerieri',
  flowPhonesSub: 'PWA sul Wi-Fi della festa',
  flowTablet: 'Tablet cucina',
  flowTabletSub: 'aggiornamenti live, zero refresh',
  flowBox: 'Una sola macchina',
  flowPrinter: 'Stampante',
  howOutro:
    'Il database è un singolo file SQLite, con backup automatico ogni 15 minuti. Un ordine preso all’1:30 di notte conta ancora per la serata in corso — i ristoranti non finiscono a mezzanotte.',
  runTitle: 'Mettilo in funzione',
  runLede: 'Un comando con Docker. La password admin generata viene stampata al primo avvio.',
  copyBtn: 'Copia',
  copiedBtn: 'Copiato!',
  dockerLogsComment: 'al primo avvio stampa la password admin generata',
  runPi:
    '<strong>Raspberry Pi?</strong> Ogni <a href="https://github.com/adefilippo83/FoodDesk/releases">release</a> include un’immagine pronta: la scrivi sulla microSD, accendi, ti colleghi al Wi-Fi FoodDesk che crea da solo e prendi le comande — senza internet, con stampanti USB che si configurano da sole. <a href="https://github.com/adefilippo83/FoodDesk/blob/main/rpi/README.md">Guida</a>.',
  runAlts:
    'Preferisci un server per la festa? <a href="https://github.com/adefilippo83/FoodDesk/blob/main/deploy/README.md">Uno script idempotente</a> configura systemd, nginx e backup su Debian. Oppure aprilo in <a href="https://codespaces.new/adefilippo83/FoodDesk">GitHub Codespaces</a> per un’istanza usa e getta.',
  principlesTitle: 'Principi che il codice fa rispettare davvero',
  principlesLede: 'TypeScript da cima a fondo · Fastify · SQLite · React 19 PWA · GPLv3.',
  pMoneyT: 'I soldi sono centesimi interi',
  pMoneyP: 'nessun float nel percorso del denaro, e i prezzi arrivano sempre dal database — un client manomesso non può farsi lo sconto.',
  pHistoryT: 'La storia è immutabile',
  pHistoryP: 'le righe d’ordine fotografano nome e prezzo; gli annullamenti hanno traccia di audit, mai cancellati. Gli scontrini di ieri sopravvivono al menù di oggi.',
  pAuthT: 'L’autorizzazione vive sul server',
  pAuthP: 'ogni rotta è protetta; la UI che nasconde le pagine admin è solo cosmesi e la suite di test è il contratto vero.',
  pHardenedT: 'Blindato di serie',
  pHardenedP: 'password scrypt, blocco anti-bruteforce, CSP e security header, controllo Origin sulle scritture, invio ordini idempotente.',
  footerLicense: 'Software libero sotto GPLv3.',
  footerReleases: 'Release',
  footerDemo: 'Demo live',
}

export const es = {
  langName: 'Español',
  title: 'FoodDesk — comandas open source para fiestas gastronómicas',
  metaDescription:
    'El sistema de comandas open source para fiestas gastronómicas, restaurantes pop-up y cocinas comunitarias. Los camareros piden desde el móvil, la cocina marca los platos en una tablet, los tickets se imprimen solos. Sin nube, sin comisiones.',
  navFeatures: 'Funciones',
  navHow: 'Cómo funciona',
  navRun: 'Instálalo',
  heroTitle: 'Adiós a las libretas de papel. <em>La cola avanza más rápido.</em>',
  heroLede:
    'FoodDesk es el sistema de comandas open source para fiestas gastronómicas, restaurantes pop-up y cocinas comunitarias. Los camareros toman los pedidos desde el móvil, la cocina marca los platos en una tablet, los tickets se imprimen solos — y al final de la noche las cuentas ya están hechas. Sin nube, sin suscripciones, sin comisiones por pedido.',
  ctaDemo: 'Prueba la demo en vivo',
  ctaRun: 'Instálalo por tu cuenta',
  demoCreds:
    'Cuentas de demo: <code>mario</code> (camarero), <code>cucina</code> (cocina), <code>admin</code> — contraseña <code>fooddesk-demo</code>. Ábrela en dos dispositivos: envía un pedido desde uno y míralo aparecer al instante en el otro.',
  featuresTitle: 'Pensado para todo el equipo',
  featuresLede: 'Cada rol tiene exactamente la pantalla que necesita — y nada más.',
  fWaitersT: 'Los camareros',
  fWaitersP:
    'Una PWA nacida para el móvil: tocas los productos, cuentas los cubiertos, añades la nota para cocina, envías. Los pedidos se numeran por jornada y un fallo de red nunca puede crear un duplicado.',
  fKitchenT: 'La cocina',
  fKitchenP:
    'Los pedidos nuevos aparecen en el instante en que se envían, sin recargar. Cada plato se marca como listo con un solo toque, y un pedido anulado grita ANULADO en vez de desaparecer en silencio.',
  fMaitreT: 'El jefe de sala',
  fMaitreP:
    'Dirige la sala con poderes casi de administrador: el menú, todos los pedidos, anulaciones e informes — pero sin página de ajustes, y del personal solo gestiona a los camareros.',
  fAdminT: 'El administrador',
  fAdminP:
    'Construye el menú, gestiona personal y roles, y diseña desde el navegador cada documento impreso — logo, marca de agua, tamaño de papel, rollo térmico de 80mm incluido — en cinco idiomas.',
  fReportsT: 'Quien lleva las cuentas',
  fReportsP:
    'Un panel diario en tiempo real: ingresos, cubiertos, media por cubierto, desglose por producto y categoría — más CSV limpio e informe PDF de una página.',
  fPrintT: 'La impresión',
  fPrintP:
    'Las comandas de cocina van directas a cualquier impresora CUPS, con reintento automático si la impresora se atasca; sin impresora, toma el relevo el diálogo de impresión del navegador.',
  shotsTitle: 'Míralo en acción',
  shotsLede: 'La demo en vivo carga una noche de fiesta de ejemplo; se reinicia cada 6 horas.',
  shotPhoneAlt: 'Tomando un pedido desde el móvil del camarero',
  shotKitchenAlt: 'Pantalla de cocina con pedidos en vivo',
  shotKitchenCap: 'La pantalla de cocina: un toque grande por plato, los pedidos se completan solos.',
  shotReportsAlt: 'Panel de informes de fin de jornada',
  shotReportsCap: 'Informes de fin de jornada: ingresos, cubiertos y desgloses, listos para exportar.',
  howTitle: 'Una noche en la fiesta',
  howLede:
    'Todo corre en una sola máquina económica — un mini-PC o una placa clase Raspberry — en el Wi-Fi del recinto. Los móviles instalan FoodDesk como una app nativa directamente desde el navegador.',
  flowPhones: 'Móviles de los camareros',
  flowPhonesSub: 'PWA en el Wi-Fi del recinto',
  flowTablet: 'Tablet de cocina',
  flowTabletSub: 'actualizaciones en vivo, sin recargar',
  flowBox: 'Una sola máquina',
  flowPrinter: 'Impresora',
  howOutro:
    'La base de datos es un único archivo SQLite, con copia de seguridad automática cada 15 minutos. Un pedido tomado a la 1:30 de la madrugada sigue contando para la jornada en curso — los restaurantes no terminan a medianoche.',
  runTitle: 'Ponlo en marcha',
  runLede: 'Un comando con Docker. La contraseña de admin generada se imprime en el primer arranque.',
  copyBtn: 'Copiar',
  copiedBtn: '¡Copiado!',
  dockerLogsComment: 'en el primer arranque imprime la contraseña de admin generada',
  runPi:
    '<strong>¿Raspberry Pi?</strong> Cada <a href="https://github.com/adefilippo83/FoodDesk/releases">versión</a> incluye una imagen lista: la grabas en la microSD, enciendes, te conectas al Wi-Fi FoodDesk que crea por sí solo y empiezas a tomar pedidos — sin internet, con impresoras USB que se configuran solas. <a href="https://github.com/adefilippo83/FoodDesk/blob/main/rpi/README.md">Guía</a>.',
  runAlts:
    '¿Prefieres un servidor propio? <a href="https://github.com/adefilippo83/FoodDesk/blob/main/deploy/README.md">Un script idempotente</a> configura systemd, nginx y backups en Debian. O ábrelo en <a href="https://codespaces.new/adefilippo83/FoodDesk">GitHub Codespaces</a> para una instancia desechable.',
  principlesTitle: 'Principios que el código hace cumplir de verdad',
  principlesLede: 'TypeScript de punta a punta · Fastify · SQLite · React 19 PWA · GPLv3.',
  pMoneyT: 'El dinero son céntimos enteros',
  pMoneyP: 'sin floats en el camino del dinero, y los precios siempre vienen de la base de datos — un cliente manipulado no puede hacerse descuentos.',
  pHistoryT: 'La historia es inmutable',
  pHistoryP: 'las líneas de pedido fotografían nombre y precio; las anulaciones quedan auditadas, nunca borradas. Los recibos de ayer sobreviven al menú de hoy.',
  pAuthT: 'La autorización vive en el servidor',
  pAuthP: 'cada ruta está protegida; que la UI oculte pantallas de admin es solo cosmética y la suite de tests es el contrato real.',
  pHardenedT: 'Blindado de serie',
  pHardenedP: 'contraseñas scrypt, bloqueo de login, CSP y cabeceras de seguridad, comprobación de Origin en escrituras, envío de pedidos idempotente.',
  footerLicense: 'Software libre bajo GPLv3.',
  footerReleases: 'Versiones',
  footerDemo: 'Demo en vivo',
}

export const fr = {
  langName: 'Français',
  title: 'FoodDesk — commandes open source pour fêtes et festivals',
  metaDescription:
    'Le système de commandes open source pour fêtes de village, restaurants éphémères et cuisines associatives. Les serveurs commandent depuis leur téléphone, la cuisine coche les plats sur tablette, les tickets s’impriment tout seuls. Sans cloud, sans commission.',
  navFeatures: 'Fonctions',
  navHow: 'Comment ça marche',
  navRun: 'Installer',
  heroTitle: 'Fini les carnets papier. <em>La file avance plus vite.</em>',
  heroLede:
    'FoodDesk est le système de commandes open source pour fêtes de village, restaurants éphémères et cuisines associatives. Les serveurs prennent les commandes sur leur téléphone, la cuisine coche les plats sur une tablette, les tickets s’impriment tout seuls — et en fin de soirée les comptes sont déjà faits. Sans cloud, sans abonnement, sans commission par commande.',
  ctaDemo: 'Essayer la démo en ligne',
  ctaRun: 'Installez-le vous-même',
  demoCreds:
    'Comptes de démo : <code>mario</code> (serveur), <code>cucina</code> (cuisine), <code>admin</code> — mot de passe <code>fooddesk-demo</code>. Ouvrez-la sur deux appareils : envoyez une commande depuis l’un et regardez-la apparaître instantanément sur l’autre.',
  featuresTitle: 'Pensé pour toute l’équipe',
  featuresLede: 'Chaque rôle a exactement l’écran qu’il lui faut — et rien de plus.',
  fWaitersT: 'Les serveurs',
  fWaitersP:
    'Une PWA née pour le téléphone : on touche les produits, on compte les couverts, on ajoute la note cuisine, on envoie. Les commandes sont numérotées par journée de service et une coupure réseau ne peut jamais créer de doublon.',
  fKitchenT: 'La cuisine',
  fKitchenP:
    'Les nouvelles commandes apparaissent à l’instant où elles partent, sans recharger. Chaque plat se marque prêt d’un seul geste, et une commande annulée crie ANNULÉE au lieu de disparaître en silence.',
  fMaitreT: 'Le maître d’hôtel',
  fMaitreP:
    'Il tient la salle avec des pouvoirs quasi admin : le menu, toutes les commandes, annulations et rapports — mais pas de page réglages, et côté personnel il ne gère que les serveurs.',
  fAdminT: 'L’administrateur',
  fAdminP:
    'Il construit le menu, gère le personnel et les rôles, et met en page chaque document imprimé depuis le navigateur — logo, filigrane, format papier, rouleau thermique 80 mm compris — en cinq langues.',
  fReportsT: 'Le trésorier',
  fReportsP:
    'Un tableau de bord quotidien en temps réel : recettes, couverts, moyenne par couvert, détail par produit et par catégorie — plus un CSV propre et un rapport PDF d’une page.',
  fPrintT: 'L’impression',
  fPrintP:
    'Les tickets cuisine partent droit vers n’importe quelle imprimante CUPS, avec réessai automatique en cas de bourrage ; sans imprimante, la boîte de dialogue d’impression du navigateur prend le relais.',
  shotsTitle: 'Voyez-le en action',
  shotsLede: 'La démo en ligne charge une soirée de fête d’exemple, réinitialisée toutes les 6 heures.',
  shotPhoneAlt: 'Prise de commande sur le téléphone du serveur',
  shotKitchenAlt: 'Écran cuisine avec les commandes en direct',
  shotKitchenCap: 'L’écran cuisine : un grand geste par plat, les commandes se terminent toutes seules.',
  shotReportsAlt: 'Tableau de bord des rapports de fin de journée',
  shotReportsCap: 'Rapports de fin de journée : recettes, couverts et détails, prêts à exporter.',
  howTitle: 'Une soirée sur place',
  howLede:
    'Tout tourne sur une seule machine bon marché — un mini-PC ou une carte type Raspberry — sur le Wi-Fi du lieu. Les téléphones installent FoodDesk comme une app native, directement depuis le navigateur.',
  flowPhones: 'Téléphones des serveurs',
  flowPhonesSub: 'PWA sur le Wi-Fi du lieu',
  flowTablet: 'Tablette cuisine',
  flowTabletSub: 'mises à jour en direct',
  flowBox: 'Une seule machine',
  flowPrinter: 'Imprimante',
  howOutro:
    'La base de données est un seul fichier SQLite, sauvegardé automatiquement toutes les 15 minutes. Une commande prise à 1 h 30 compte encore pour la soirée en cours — les restaurants ne s’arrêtent pas à minuit.',
  runTitle: 'Mettez-le en route',
  runLede: 'Une commande avec Docker. Le mot de passe admin généré s’affiche au premier démarrage.',
  copyBtn: 'Copier',
  copiedBtn: 'Copié !',
  dockerLogsComment: 'le mot de passe admin généré s’affiche au premier démarrage',
  runPi:
    '<strong>Raspberry Pi ?</strong> Chaque <a href="https://github.com/adefilippo83/FoodDesk/releases">version</a> fournit une image prête à l’emploi : flashez la microSD, allumez, rejoignez le Wi-Fi FoodDesk qu’il crée tout seul et prenez les commandes — sans internet, avec des imprimantes USB qui se configurent seules. <a href="https://github.com/adefilippo83/FoodDesk/blob/main/rpi/README.md">Guide</a>.',
  runAlts:
    'Vous préférez un serveur sur place ? <a href="https://github.com/adefilippo83/FoodDesk/blob/main/deploy/README.md">Un script idempotent</a> configure systemd, nginx et les backups sur Debian. Ou ouvrez-le dans <a href="https://codespaces.new/adefilippo83/FoodDesk">GitHub Codespaces</a> pour une instance jetable.',
  principlesTitle: 'Des principes que le code fait vraiment respecter',
  principlesLede: 'TypeScript de bout en bout · Fastify · SQLite · React 19 PWA · GPLv3.',
  pMoneyT: 'L’argent est en centimes entiers',
  pMoneyP: 'aucun float sur le chemin de l’argent, et les prix viennent toujours de la base — un client trafiqué ne peut pas se faire de remise.',
  pHistoryT: 'L’historique est immuable',
  pHistoryP: 'les lignes de commande figent nom et prix ; les annulations sont auditées, jamais effacées. Les tickets d’hier survivent au menu d’aujourd’hui.',
  pAuthT: 'L’autorisation vit côté serveur',
  pAuthP: 'chaque route est protégée ; l’UI qui masque les écrans admin n’est que cosmétique et la suite de tests est le vrai contrat.',
  pHardenedT: 'Blindé d’origine',
  pHardenedP: 'mots de passe scrypt, verrouillage du login, CSP et en-têtes de sécurité, contrôle d’Origin sur les écritures, envoi de commandes idempotent.',
  footerLicense: 'Logiciel libre sous GPLv3.',
  footerReleases: 'Versions',
  footerDemo: 'Démo en ligne',
}

export const pt = {
  langName: 'Português',
  title: 'FoodDesk — pedidos open source para festas gastronómicas',
  metaDescription:
    'O sistema de pedidos open source para festas gastronómicas, restaurantes pop-up e cozinhas comunitárias. Os empregados pedem pelo telemóvel, a cozinha marca os pratos num tablet, os talões imprimem-se sozinhos. Sem nuvem, sem comissões.',
  navFeatures: 'Funções',
  navHow: 'Como funciona',
  navRun: 'Instalar',
  heroTitle: 'Adeus aos blocos de papel. <em>A fila anda mais depressa.</em>',
  heroLede:
    'O FoodDesk é o sistema de pedidos open source para festas gastronómicas, restaurantes pop-up e cozinhas comunitárias. Os empregados registam os pedidos no telemóvel, a cozinha marca os pratos num tablet, os talões imprimem-se sozinhos — e no fim da noite as contas já estão feitas. Sem nuvem, sem subscrições, sem comissões por pedido.',
  ctaDemo: 'Experimenta a demo ao vivo',
  ctaRun: 'Instala tu mesmo',
  demoCreds:
    'Contas de demonstração: <code>mario</code> (empregado), <code>cucina</code> (cozinha), <code>admin</code> — palavra-passe <code>fooddesk-demo</code>. Abre em dois dispositivos: envia um pedido num deles e vê-o aparecer no outro no mesmo instante.',
  featuresTitle: 'Pensado para toda a equipa',
  featuresLede: 'Cada função tem exatamente o ecrã de que precisa — e nada mais.',
  fWaitersT: 'Os empregados',
  fWaitersP:
    'Uma PWA nascida para o telemóvel: tocas nos produtos, contas os couverts, acrescentas a nota para a cozinha, envias. Os pedidos são numerados por jornada e uma falha de rede nunca cria um duplicado.',
  fKitchenT: 'A cozinha',
  fKitchenP:
    'Os pedidos novos aparecem no instante em que são enviados, sem recarregar. Cada prato marca-se como pronto com um só toque, e um pedido anulado grita ANULADO em vez de desaparecer em silêncio.',
  fMaitreT: 'O chefe de sala',
  fMaitreP:
    'Comanda a sala com poderes quase de administrador: o menu, todos os pedidos, anulações e relatórios — mas sem página de definições, e no pessoal só gere os empregados de mesa.',
  fAdminT: 'O administrador',
  fAdminP:
    'Constrói o menu, gere pessoal e funções, e desenha no navegador todos os documentos impressos — logótipo, marca de água, tamanho do papel, rolo térmico de 80mm incluído — em cinco idiomas.',
  fReportsT: 'Quem faz as contas',
  fReportsP:
    'Um painel diário em tempo real: receitas, couverts, média por couvert, detalhe por produto e categoria — mais CSV limpo e relatório PDF de uma página.',
  fPrintT: 'A impressão',
  fPrintP:
    'Os talões de cozinha vão diretos para qualquer impressora CUPS, com nova tentativa automática se a impressora encravar; sem impressora, entra em ação o diálogo de impressão do navegador.',
  shotsTitle: 'Vê em ação',
  shotsLede: 'A demo ao vivo carrega uma noite de festa de exemplo, reiniciada a cada 6 horas.',
  shotPhoneAlt: 'A registar um pedido no telemóvel do empregado',
  shotKitchenAlt: 'Ecrã de cozinha com pedidos ao vivo',
  shotKitchenCap: 'O ecrã da cozinha: um toque grande por prato, os pedidos completam-se sozinhos.',
  shotReportsAlt: 'Painel de relatórios de fim de dia',
  shotReportsCap: 'Relatórios de fim de dia: receitas, couverts e detalhes, prontos a exportar.',
  howTitle: 'Uma noite na festa',
  howLede:
    'Tudo corre numa única máquina barata — um mini-PC ou uma placa classe Raspberry — no Wi-Fi do recinto. Os telemóveis instalam o FoodDesk como uma app nativa, diretamente do navegador.',
  flowPhones: 'Telemóveis dos empregados',
  flowPhonesSub: 'PWA no Wi-Fi do recinto',
  flowTablet: 'Tablet da cozinha',
  flowTabletSub: 'atualizações ao vivo',
  flowBox: 'Uma única máquina',
  flowPrinter: 'Impressora',
  howOutro:
    'A base de dados é um único ficheiro SQLite, com cópia de segurança automática a cada 15 minutos. Um pedido registado à 1h30 ainda conta para a noite em curso — os restaurantes não acabam à meia-noite.',
  runTitle: 'Põe-no a funcionar',
  runLede: 'Um comando com Docker. A palavra-passe de admin gerada é impressa no primeiro arranque.',
  copyBtn: 'Copiar',
  copiedBtn: 'Copiado!',
  dockerLogsComment: 'no primeiro arranque imprime a palavra-passe de admin gerada',
  runPi:
    '<strong>Raspberry Pi?</strong> Cada <a href="https://github.com/adefilippo83/FoodDesk/releases">versão</a> traz uma imagem pronta: gravas no microSD, ligas, entras no Wi-Fi FoodDesk que ele próprio cria e começas a registar pedidos — sem internet, com impressoras USB que se configuram sozinhas. <a href="https://github.com/adefilippo83/FoodDesk/blob/main/rpi/README.md">Guia</a>.',
  runAlts:
    'Preferes um servidor no local? <a href="https://github.com/adefilippo83/FoodDesk/blob/main/deploy/README.md">Um script idempotente</a> configura systemd, nginx e backups em Debian. Ou abre-o no <a href="https://codespaces.new/adefilippo83/FoodDesk">GitHub Codespaces</a> para uma instância descartável.',
  principlesTitle: 'Princípios que o código faz mesmo cumprir',
  principlesLede: 'TypeScript de ponta a ponta · Fastify · SQLite · React 19 PWA · GPLv3.',
  pMoneyT: 'O dinheiro são cêntimos inteiros',
  pMoneyP: 'sem floats no caminho do dinheiro, e os preços vêm sempre da base de dados — um cliente adulterado não consegue obter descontos.',
  pHistoryT: 'A história é imutável',
  pHistoryP: 'as linhas de pedido fotografam nome e preço; as anulações ficam auditadas, nunca apagadas. Os recibos de ontem sobrevivem ao menu de hoje.',
  pAuthT: 'A autorização vive no servidor',
  pAuthP: 'todas as rotas estão protegidas; a UI que esconde os ecrãs de admin é só cosmética e a suite de testes é o contrato verdadeiro.',
  pHardenedT: 'Blindado de origem',
  pHardenedP: 'palavras-passe scrypt, bloqueio de login, CSP e cabeçalhos de segurança, verificação de Origin nas escritas, envio de pedidos idempotente.',
  footerLicense: 'Software livre sob GPLv3.',
  footerReleases: 'Versões',
  footerDemo: 'Demo ao vivo',
}

export const languages = { en, it, es, fr, pt }
