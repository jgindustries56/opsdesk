'use strict';

const express = require('express');
const db = require('../db');
const { loadInvoice } = require('../lib');

const router = express.Router();

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ contacts: [], invoices: [], messages: [] });

  const contacts = (await db.all('SELECT * FROM contacts'))
    .filter((c) => [c.name, c.company, c.email, c.phone].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
    .slice(0, 8);

  const contactMap = new Map(contacts.map((c) => [String(c.id), c]));
  const allContacts = await db.all('SELECT id, name, company FROM contacts');
  const allContactMap = new Map(allContacts.map((c) => [String(c.id), c]));

  const invoiceRows = (await db.all('SELECT * FROM invoices')).filter((i) => {
    const contact = allContactMap.get(String(i.contact_id));
    return [i.number, i.notes, contact?.name, contact?.company]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });
  const invoices = [];
  for (const inv of invoiceRows.slice(0, 8)) {
    const full = await loadInvoice(inv.id);
    invoices.push({ ...inv, contact: allContactMap.get(String(inv.contact_id)) || null, totals: full.totals });
  }

  const messageRows = (await db.all('SELECT * FROM messages ORDER BY occurred_at DESC'))
    .filter((m) => {
      const contact = allContactMap.get(String(m.contact_id));
      return [m.subject, m.body, contact?.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    })
    .slice(0, 8)
    .map((m) => ({ ...m, contact: allContactMap.get(String(m.contact_id)) || null }));

  res.json({ contacts, invoices, messages: messageRows });
});

module.exports = router;
