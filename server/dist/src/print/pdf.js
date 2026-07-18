import PDFDocument from 'pdfkit';
/**
 * Both documents are laid out for 80mm thermal roll paper (72.1mm printable),
 * which is also perfectly readable printed on A4 from a browser. The page
 * height is computed from the content so a roll printer cuts right after the
 * last line instead of feeding blank paper.
 */
const MM = 72 / 25.4;
const PAGE_W = 80 * MM;
const MARGIN = 4 * MM;
const INNER_W = PAGE_W - MARGIN * 2;
const RESTAURANT_NAME = process.env.RESTAURANT_NAME ?? 'FoodDesk';
const CURRENCY = process.env.CURRENCY_SYMBOL ?? '€';
function money(cents) {
    return `${CURRENCY}${(cents / 100).toFixed(2)}`;
}
function timeOf(order) {
    return new Date(order.createdAt * 1000).toLocaleTimeString('it-IT', {
        hour: '2-digit',
        minute: '2-digit',
    });
}
function ticketNo(order) {
    return String(order.dailyNumber).padStart(3, '0');
}
function collect(doc) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}
function newDoc(estimatedHeight) {
    return new PDFDocument({
        size: [PAGE_W, Math.max(estimatedHeight, 60 * MM)],
        margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    });
}
function dashes(doc) {
    doc.moveDown(0.4);
    doc
        .moveTo(MARGIN, doc.y)
        .lineTo(PAGE_W - MARGIN, doc.y)
        .dash(2, { space: 2 })
        .strokeColor('#000')
        .stroke()
        .undash();
    doc.moveDown(0.4);
}
/**
 * Kitchen ticket: what to make, for which table, in big type. No prices —
 * the kitchen does not care, and large glyphs survive steam and distance.
 */
export function renderKitchenTicket(order, items) {
    const noteLines = items.filter((i) => i.note).length + (order.note ? 2 : 0);
    const height = 42 * MM + items.length * 9 * MM + noteLines * 6 * MM;
    const doc = newDoc(height);
    doc.font('Helvetica-Bold').fontSize(26).text(`#${ticketNo(order)}`, { align: 'center' });
    doc
        .font('Helvetica')
        .fontSize(12)
        .text(`${order.tableLabel ? `Table ${order.tableLabel}  ·  ` : ''}${timeOf(order)}`, {
        align: 'center',
    });
    dashes(doc);
    for (const item of items) {
        doc.font('Helvetica-Bold').fontSize(15).text(`${item.qty} × ${item.nameSnapshot}`);
        if (item.note) {
            doc.font('Helvetica-Oblique').fontSize(11).text(`   » ${item.note}`);
        }
        doc.moveDown(0.25);
    }
    if (order.note) {
        dashes(doc);
        doc.font('Helvetica-Oblique').fontSize(12).text(order.note);
    }
    return collect(doc);
}
/** Customer receipt: itemised with prices and the total. */
export function renderReceipt(order, items) {
    const noteLines = items.filter((i) => i.note).length;
    const height = 55 * MM + items.length * 7 * MM + noteLines * 5 * MM;
    const doc = newDoc(height);
    doc.font('Helvetica-Bold').fontSize(16).text(RESTAURANT_NAME, { align: 'center' });
    doc
        .font('Helvetica')
        .fontSize(10)
        .text(`Order #${ticketNo(order)}${order.tableLabel ? ` · Table ${order.tableLabel}` : ''}`, { align: 'center' })
        .text(`${order.serviceDay} · ${timeOf(order)}`, { align: 'center' });
    dashes(doc);
    const priceW = 18 * MM;
    for (const item of items) {
        const y = doc.y;
        doc
            .font('Helvetica')
            .fontSize(11)
            .text(`${item.qty} × ${item.nameSnapshot}`, MARGIN, y, { width: INNER_W - priceW });
        const rowBottom = doc.y;
        doc.text(money(item.priceCentsSnapshot * item.qty), MARGIN + INNER_W - priceW, y, {
            width: priceW,
            align: 'right',
        });
        doc.y = Math.max(doc.y, rowBottom);
        doc.x = MARGIN;
        if (item.note) {
            doc.font('Helvetica-Oblique').fontSize(9).text(`   ${item.note}`);
        }
        doc.moveDown(0.15);
    }
    dashes(doc);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(14).text('TOTAL', MARGIN, y);
    doc.text(money(order.totalCents), MARGIN, y, { width: INNER_W, align: 'right' });
    doc.x = MARGIN;
    doc.moveDown(0.8);
    doc.font('Helvetica').fontSize(9).text('Grazie!', { align: 'center' });
    return collect(doc);
}
