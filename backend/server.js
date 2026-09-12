const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 10000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const query = (text, values) => pool.query(text, values);
const number = (value, fallback = 0) => Number(value ?? fallback);
const dateOrToday = (value) => value || new Date().toISOString().slice(0, 10);

async function initializeDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(schema);
}

app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

app.get('/api/menu/active', async (req, res) => {
  const result = await query('SELECT menu_item_id AS "menuItemId", name, category, price, active, size FROM menu_items WHERE active = TRUE ORDER BY category, name');
  res.json(result.rows);
});

app.get('/api/menu', async (req, res) => {
  const result = await query('SELECT menu_item_id AS "menuItemId", name, category, price, active, size FROM menu_items ORDER BY category, name');
  res.json(result.rows);
});

app.post('/api/menu', async (req, res) => {
  const { name, category = 'General', price, size = null } = req.body;
  const result = await query('INSERT INTO menu_items (name, category, price, size) VALUES ($1, $2, $3, $4) RETURNING menu_item_id', [name, category, price, size]);
  res.status(201).json({ menuItemId: result.rows[0].menu_item_id });
});

app.put('/api/menu/:id/price', async (req, res) => {
  await query('UPDATE menu_items SET price = $1 WHERE menu_item_id = $2', [req.body.price, req.params.id]);
  res.json({ success: true });
});

app.put('/api/menu/:id/status', async (req, res) => {
  await query('UPDATE menu_items SET active = $1 WHERE menu_item_id = $2', [Boolean(req.body.active), req.params.id]);
  res.json({ success: true });
});

app.delete('/api/menu/:id', async (req, res) => {
  await query('DELETE FROM menu_items WHERE menu_item_id = $1', [req.params.id]);
  res.json({ success: true });
});

app.delete('/api/menu', async (req, res) => {
  await query('DELETE FROM menu_items');
  res.json({ success: true });
});

app.get('/api/inventory', async (req, res) => {
  const result = await query('SELECT item_id AS "itemId", item_name AS "itemName", quantity, reorder_level AS "reorderLevel", last_unit_price AS "lastUnitPrice" FROM inventory_items ORDER BY item_name');
  res.json(result.rows);
});

app.get('/api/inventory/search', async (req, res) => {
  const result = await query('SELECT item_id AS "itemId", item_name AS "itemName", quantity, reorder_level AS "reorderLevel", last_unit_price AS "lastUnitPrice" FROM inventory_items WHERE item_name ILIKE $1 ORDER BY item_name', [`%${req.query.q || ''}%`]);
  res.json(result.rows);
});

app.get('/api/inventory/low-stock', async (req, res) => {
  const result = await query('SELECT item_id AS "itemId", item_name AS "itemName", quantity, reorder_level AS "reorderLevel", last_unit_price AS "lastUnitPrice" FROM inventory_items WHERE quantity <= reorder_level ORDER BY item_name');
  res.json(result.rows);
});

app.post('/api/inventory', async (req, res) => {
  const { itemName, reorderLevel = 0 } = req.body;
  const result = await query('INSERT INTO inventory_items (item_name, reorder_level) VALUES ($1, $2) RETURNING item_id', [itemName, reorderLevel]);
  res.status(201).json({ itemId: result.rows[0].item_id });
});

app.delete('/api/inventory/:id', async (req, res) => {
  await query('DELETE FROM inventory_items WHERE item_id = $1', [req.params.id]);
  res.json({ success: true });
});

app.delete('/api/inventory', async (req, res) => {
  await query('DELETE FROM inventory_items');
  res.json({ success: true });
});

app.get('/api/orders/generate-no', async (req, res) => {
  const result = await query("SELECT 'ORD-' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || '-' || LPAD((COUNT(*) + 1)::text, 4, '0') AS \"orderNo\" FROM orders WHERE order_date = CURRENT_DATE");
  res.json(result.rows[0]);
});

app.post('/api/orders', async (req, res) => {
  const order = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(`INSERT INTO orders (order_no, order_date, order_time, customer_name, order_type, payment_type, subtotal, discount, delivery_charge, service_charge_percent, service_charge, total_amount, status) VALUES ($1, $2, CURRENT_TIME, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING order_id`, [order.orderNo, dateOrToday(order.orderDate), order.customerName || '', order.orderType || 'Dine In', order.paymentType || 'Cash', number(order.subtotal), number(order.discount), number(order.deliveryCharge), number(order.serviceChargePercent), number(order.serviceCharge), number(order.totalAmount), order.status || 'Completed']);
    for (const item of order.items || []) {
      await client.query('INSERT INTO order_items (order_id, menu_item_id, menu_item_name, quantity, unit_price, line_total) VALUES ($1, $2, $3, $4, $5, $6)', [orderResult.rows[0].order_id, item.menuItemId || null, item.menuItemName || '', number(item.quantity, 1), number(item.unitPrice), number(item.lineTotal)]);
    }
    await client.query('COMMIT');
    res.status(201).json({ orderId: orderResult.rows[0].order_id });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/orders/range', async (req, res) => {
  const result = await query('SELECT order_id AS "orderId", order_no AS "orderNo", order_date AS "orderDate", order_time AS "orderTime", customer_name AS "customerName", order_type AS "orderType", payment_type AS "paymentType", subtotal, discount, delivery_charge AS "deliveryCharge", service_charge_percent AS "serviceChargePercent", service_charge AS "serviceCharge", total_amount AS "totalAmount", status FROM orders WHERE order_date BETWEEN $1 AND $2 ORDER BY order_date DESC, order_time DESC', [req.query.from, req.query.to]);
  res.json(result.rows);
});

app.get('/api/orders/:id', async (req, res) => {
  const order = await query('SELECT order_id AS "orderId", order_no AS "orderNo", order_date AS "orderDate", order_time AS "orderTime", customer_name AS "customerName", order_type AS "orderType", payment_type AS "paymentType", subtotal, discount, delivery_charge AS "deliveryCharge", service_charge_percent AS "serviceChargePercent", service_charge AS "serviceCharge", total_amount AS "totalAmount", status FROM orders WHERE order_id = $1', [req.params.id]);
  if (!order.rowCount) return res.status(404).json({ error: 'Order not found' });
  const items = await query('SELECT menu_item_id AS "menuItemId", menu_item_name AS "menuItemName", quantity, unit_price AS "unitPrice", line_total AS "lineTotal" FROM order_items WHERE order_id = $1 ORDER BY order_item_id', [req.params.id]);
  res.json({ ...order.rows[0], items: items.rows });
});

app.get('/api/sales/date/:date', async (req, res) => {
  const result = await query("SELECT COALESCE(SUM(total_amount), 0) AS \"totalSales\", COUNT(*)::int AS \"orderCount\" FROM orders WHERE order_date = $1", [req.params.date]);
  res.json(result.rows[0]);
});

app.get('/api/stock-in/generate-no', async (req, res) => {
  const result = await query("SELECT 'STK-' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || '-' || LPAD((COUNT(*) + 1)::text, 4, '0') AS \"billNo\" FROM stock_in WHERE stock_date = CURRENT_DATE");
  res.json(result.rows[0]);
});

app.get('/api/stock-in/range', async (req, res) => {
  const result = await query('SELECT stock_in_id AS "stockInId", bill_no AS "billNo", stock_date AS "stockDate", total_amount AS "totalAmount", remarks FROM stock_in WHERE stock_date BETWEEN $1 AND $2 ORDER BY stock_date DESC', [req.query.from, req.query.to]);
  res.json(result.rows);
});

app.get('/api/stock-in/:id', async (req, res) => {
  const bill = await query('SELECT stock_in_id AS "stockInId", bill_no AS "billNo", stock_date AS "stockDate", total_amount AS "totalAmount", remarks FROM stock_in WHERE stock_in_id = $1', [req.params.id]);
  if (!bill.rowCount) return res.status(404).json({ error: 'Stock-in bill not found' });
  const items = await query('SELECT item_id AS "itemId", item_name AS "itemName", quantity, unit_price AS "unitPrice", line_total AS "lineTotal" FROM stock_in_items WHERE stock_in_id = $1 ORDER BY stock_in_item_id', [req.params.id]);
  res.json({ ...bill.rows[0], items: items.rows });
});

app.post('/api/stock-in', async (req, res) => {
  const bill = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = await client.query('INSERT INTO stock_in (bill_no, stock_date, total_amount, remarks) VALUES ($1, $2, $3, $4) RETURNING stock_in_id', [bill.billNo, dateOrToday(bill.stockDate), number(bill.totalAmount), bill.remarks || '']);
    for (const item of bill.items || []) {
      await client.query('INSERT INTO stock_in_items (stock_in_id, item_id, item_name, quantity, unit_price, line_total) VALUES ($1, $2, $3, $4, $5, $6)', [saved.rows[0].stock_in_id, item.itemId || null, item.itemName || '', number(item.quantity), number(item.unitPrice), number(item.lineTotal)]);
      if (item.itemId) {
        await client.query('INSERT INTO inventory_items (item_id, item_name, quantity, last_unit_price) VALUES ($1, $2, $3, $4) ON CONFLICT (item_id) DO UPDATE SET quantity = inventory_items.quantity + EXCLUDED.quantity, last_unit_price = EXCLUDED.last_unit_price', [item.itemId, item.itemName, number(item.quantity), number(item.unitPrice)]);
      } else {
        await client.query('INSERT INTO inventory_items (item_name, quantity, last_unit_price) VALUES ($1, $2, $3) ON CONFLICT (item_name) DO UPDATE SET quantity = inventory_items.quantity + EXCLUDED.quantity, last_unit_price = EXCLUDED.last_unit_price', [item.itemName, number(item.quantity), number(item.unitPrice)]);
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ stockInId: saved.rows[0].stock_in_id });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

initializeDatabase()
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`BKR API listening on port ${port}`)))
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
