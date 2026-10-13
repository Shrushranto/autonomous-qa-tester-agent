const express = require("express");
const path = require("path");

const VALID_BUGS = ["coupon_twice", "negative_qty", "stale_total", "bad_email"];

const PRODUCTS = [
  { id: "p1", name: "Notebook", price: 200 },

  { id: "p2", name: "Headphones", price: 1200 },

  { id: "p3", name: "Mug", price: 400 },
];

const COUPON_CODE = "SAVE10";

const COUPON_RATE = 0.1;

const PORT = Number(process.env.PORT) || 3000;

function parseBugs() {
  const fromArg = process.argv.slice(2).find((a) => !a.startsWith("-"));

  const raw = process.env.BUGS || fromArg || "none";

  if (raw === "none" || raw.trim() === "") return new Set();

  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const unknown = parts.filter((p) => !VALID_BUGS.includes(p));

  if (unknown.length) {
    console.error("Unknown BUGS value(s):", unknown.join(", "));

    console.error("Valid:", VALID_BUGS.join(", "), "or none");

    process.exit(1);
  }

  return new Set(parts);
}

const enabledBugs = parseBugs();

function emptyState() {
  return {
    cart: [],

    appliedCoupons: [],

    registeredEmails: [],

    staleTotal: null,
  };
}

let state = emptyState();

function productById(id) {
  return PRODUCTS.find((p) => p.id === id);
}

function subtotal() {
  return state.cart.reduce((sum, line) => sum + line.price * line.qty, 0);
}

function discountAmount(sub) {
  return sub * COUPON_RATE * state.appliedCoupons.length;
}

function cartTotal() {
  if (enabledBugs.has("stale_total") && state.staleTotal !== null) {
    return state.staleTotal;
  }

  const sub = subtotal();

  return sub - discountAmount(sub);
}

function publicCart() {
  return {
    items: state.cart.map((line) => ({
      id: line.id,

      name: line.name,

      price: line.price,

      qty: line.qty,

      lineTotal: line.price * line.qty,
    })),

    subtotal: subtotal(),

    discount: discountAmount(subtotal()),

    total: cartTotal(),

    appliedCoupons: [...state.appliedCoupons],
  };
}

function jsonError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

const app = express();

app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/products", (_req, res) => {
  res.json({ ok: true, products: PRODUCTS });
});

app.get("/api/cart", (_req, res) => {
  res.json({ ok: true, cart: publicCart() });
});

app.post("/api/cart", (req, res) => {
  const productId = req.body && req.body.productId;

  const product = productById(productId);

  if (!product) return jsonError(res, 400, "Unknown product");

  const existing = state.cart.find((line) => line.id === product.id);

  if (existing) existing.qty += 1;
  else
    state.cart.push({
      id: product.id,
      name: product.name,
      price: product.price,
      qty: 1,
    });

  res.json({ ok: true, cart: publicCart() });
});

app.patch("/api/cart/:id", (req, res) => {
  const line = state.cart.find((item) => item.id === req.params.id);

  if (!line) return jsonError(res, 404, "Item not in cart");

  const qty = Number(req.body && req.body.quantity);

  if (!Number.isInteger(qty))
    return jsonError(res, 400, "Quantity must be an integer");

  if (!enabledBugs.has("negative_qty") && qty < 1) {
    return jsonError(res, 400, "Quantity must be a positive integer");
  }

  line.qty = qty;

  res.json({ ok: true, cart: publicCart() });
});

app.delete("/api/cart/:id", (req, res) => {
  const index = state.cart.findIndex((item) => item.id === req.params.id);

  if (index === -1) return jsonError(res, 404, "Item not in cart");

  if (enabledBugs.has("stale_total")) {
    state.staleTotal = cartTotal();
  }

  state.cart.splice(index, 1);

  res.json({ ok: true, cart: publicCart() });
});

app.post("/api/coupon", (req, res) => {
  const code = String((req.body && req.body.code) || "")
    .trim()
    .toUpperCase();

  if (code !== COUPON_CODE) return jsonError(res, 400, "Unknown coupon code");

  const already = state.appliedCoupons.includes(code);

  if (already && !enabledBugs.has("coupon_twice")) {
    return jsonError(res, 400, "Coupon already applied to this order");
  }

  state.appliedCoupons.push(code);

  res.json({ ok: true, cart: publicCart() });
});

app.post("/api/signup", (req, res) => {
  const email = String((req.body && req.body.email) || "").trim();

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  if (!enabledBugs.has("bad_email") && !valid) {
    return jsonError(res, 400, "Signup requires a valid email");
  }

  if (!email) return jsonError(res, 400, "Email is required");

  state.registeredEmails.push(email);

  res.json({ ok: true, email });
});

app.post("/__reset", (_req, res) => {
  state = emptyState();

  res.json({ ok: true, state: exposeState() });
});

function exposeState() {
  return {
    products: PRODUCTS,

    cart: state.cart.map((line) => ({
      id: line.id,

      name: line.name,

      price: line.price,

      quantity: line.qty,
    })),

    prices: Object.fromEntries(PRODUCTS.map((p) => [p.id, p.price])),

    quantities: Object.fromEntries(
      state.cart.map((line) => [line.id, line.qty]),
    ),

    appliedCoupons: [...state.appliedCoupons],

    registeredEmails: [...state.registeredEmails],

    subtotal: subtotal(),

    total: cartTotal(),
  };
}

app.get("/__state", (_req, res) => {
  res.json(exposeState());
});

app.listen(PORT, () => {
  const label = enabledBugs.size ? [...enabledBugs].join(",") : "none";

  console.log(`Demo shop http://localhost:${PORT}  BUGS=${label}`);
});
