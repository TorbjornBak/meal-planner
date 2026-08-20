// Tests for the receipt-total picker (§7). Run with `npm test`.
//
// Node runs the TypeScript module directly (type stripping), so there's no test
// framework or build step to keep alive. The samples below are the shapes real
// Danish supermarket receipts come back in once OCR has had its way with them.

import test from "node:test";
import assert from "node:assert/strict";

import { findReceiptTotal } from "./receiptTotal.ts";

test("picks the labelled total over cash tendered, change and VAT", () => {
  const receipt = `
NETTO
Ndr Fasanvej 100
CVR 35954716

ØKO MÆLK 1L        12,95
RUGBRØD            22,50
2 x KAFFE 45,00    90,00
BANANER 1,240 kg    8,60

TOTAL             134,05
KONTANT           200,00
BYTTEPENGE         65,95
HERAF MOMS         26,81
`;
  assert.deepEqual(findReceiptTotal(receipt), {
    amount: 134.05,
    line: "TOTAL             134,05",
    basis: "keyword",
  });
});

test("reads Danish thousands separators", () => {
  const got = findReceiptTotal("AT BETALE      1.234,50\nMOMS UDGØR       246,90");
  assert.equal(got?.amount, 1234.5);
  assert.equal(got?.basis, "keyword");
});

test("reads English separators too", () => {
  assert.equal(findReceiptTotal("TOTAL 1,234.50")?.amount, 1234.5);
});

test("prefers the more explicit label when several are present", () => {
  const got = findReceiptTotal("SUBTOTAL 300,00\nTOTAL RABAT 25,00\nAT BETALE 275,00");
  assert.equal(got?.amount, 275);
});

test("takes the last of two equally-labelled totals", () => {
  // Two-copy receipts print the merchant's total above the customer's.
  const got = findReceiptTotal("TOTAL 342,75\n--- KUNDENS KOPI ---\nTOTAL 342,75");
  assert.equal(got?.line, "TOTAL 342,75");
  assert.equal(got?.amount, 342.75);
});

test("borrows the amount from the next line when the label stands alone", () => {
  const got = findReceiptTotal("VARER 3\nI ALT\n        342,75\n");
  assert.equal(got?.amount, 342.75);
  assert.equal(got?.basis, "keyword");
});

test("falls back to the largest amount when no label survived OCR", () => {
  const got = findReceiptTotal("V4RE 1   25,00\nV4RE 2   99,50");
  assert.deepEqual(got, {
    amount: 99.5,
    line: "V4RE 2   99,50",
    basis: "largest",
  });
});

test("the fallback still refuses cash tendered", () => {
  // Tendered cash is larger than the total, so "just take the biggest number"
  // would get this wrong; the exclusions apply to the fallback too.
  const got = findReceiptTotal("KONTANT 400,00\nVARE 25,00");
  assert.equal(got?.amount, 25);
  assert.equal(got?.basis, "largest");
});

test("ignores negated amounts", () => {
  assert.equal(findReceiptTotal("RABAT -50,00\nVARE 25,00")?.amount, 25);
  assert.equal(findReceiptTotal("RETUR 50,00-\nVARE 25,00")?.amount, 25);
});

test("ignores numbers that aren't money", () => {
  // Item counts, dates and the store's CVR number all lack øre.
  assert.equal(findReceiptTotal("TOTAL 3 VARER\n19-08-2026 17:42\nCVR 35954716"), null);
});

test("returns null for an unreadable receipt", () => {
  assert.equal(findReceiptTotal(""), null);
  assert.equal(findReceiptTotal("~~ mmm ~~\n\n"), null);
});
