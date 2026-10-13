function showMessage(text, kind) {
  const el = document.getElementById("message");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "message" + (kind ? " " + kind : "");
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function rupees(n) {
  return "Rs " + Number(n).toLocaleString("en-IN");
}

async function loadProducts() {
  const list = document.getElementById("product-list");
  if (!list) return;
  const data = await api("/api/products");
  list.innerHTML = "";
  data.products.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML =
      "<span>" + p.name + " — " + rupees(p.price) + "</span>";
    const btn = document.createElement("button");
    btn.id = "add-" + p.id;
    btn.textContent = "Add to cart";
    btn.addEventListener("click", async () => {
      try {
        await api("/api/cart", {
          method: "POST",
          body: JSON.stringify({ productId: p.id }),
        });
        showMessage(p.name + " added to cart.", "ok");
      } catch (err) {
        showMessage(err.message, "error");
      }
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
}

async function loadCart() {
  const table = document.getElementById("cart-table");
  const body = document.getElementById("cart-body");
  const empty = document.getElementById("cart-empty");
  const totalEl = document.getElementById("cart-total");
  if (!body || !totalEl) return;

  const data = await api("/api/cart");
  const cart = data.cart;
  totalEl.textContent = "Cart total: " + rupees(cart.total);

  if (!cart.items.length) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }
  empty.hidden = true;
  table.hidden = false;
  body.innerHTML = "";

  cart.items.forEach((item) => {
    const tr = document.createElement("tr");
    const qtyId = "qty-" + item.id;
    const removeId = "remove-" + item.id;
    tr.innerHTML =
      "<td>" + item.name + "</td>" +
      "<td>" + rupees(item.price) + "</td>" +
      "<td><input id=\"" + qtyId + "\" type=\"number\" value=\"" + item.qty + "\" /></td>" +
      "<td><button id=\"" + removeId + "\" class=\"secondary\" type=\"button\">Remove</button></td>";
    body.appendChild(tr);

    document.getElementById(qtyId).addEventListener("change", async (ev) => {
      try {
        await api("/api/cart/" + item.id, {
          method: "PATCH",
          body: JSON.stringify({ quantity: Number(ev.target.value) }),
        });
        showMessage("Quantity updated.", "ok");
        await loadCart();
      } catch (err) {
        showMessage(err.message, "error");
        await loadCart();
      }
    });

    document.getElementById(removeId).addEventListener("click", async () => {
      try {
        await api("/api/cart/" + item.id, { method: "DELETE" });
        showMessage("Item removed.", "ok");
        await loadCart();
      } catch (err) {
        showMessage(err.message, "error");
      }
    });
  });
}

function bindCoupon() {
  const form = document.getElementById("coupon-form");
  if (!form) return;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = document.getElementById("coupon-code").value;
    try {
      await api("/api/coupon", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      showMessage("Coupon applied.", "ok");
      await loadCart();
    } catch (err) {
      showMessage(err.message, "error");
    }
  });
}

function bindSignup() {
  const form = document.getElementById("signup-form");
  if (!form) return;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = document.getElementById("signup-email").value;
    try {
      await api("/api/signup", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      showMessage("Account created for " + email + ".", "ok");
    } catch (err) {
      showMessage(err.message, "error");
    }
  });
}

loadProducts().catch((err) => showMessage(err.message, "error"));
loadCart().catch((err) => showMessage(err.message, "error"));
bindCoupon();
bindSignup();
