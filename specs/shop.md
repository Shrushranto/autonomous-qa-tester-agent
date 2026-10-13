# Shopper's Stop — expected behavior

This specification describes the correct behavior of the demo shopping application. Test only what is written here. Do not invent extra rules.

## Products and cart

Users can browse products, add them to the cart, change quantities, remove products, and see a cart total.

- **R1 — Quantity must be a positive integer.** Changing an item quantity to zero or a negative number must be rejected. The cart must stay unchanged when an invalid quantity is submitted.
- **R4 — Cart total equals the sum of price times quantity, minus any valid coupon discount.** After adding, changing quantity, or removing an item, the displayed total must match that calculation.

The maximum quantity allowed per item is not specified.

## Coupons

A coupon may be applied to an order.

- **R3 — A coupon applies only once per order.** Applying the same coupon code repeatedly must not apply the discount more than once.

## Signup

Users can register with an email address.

- **R5 — Signup requires a valid email.** Addresses that are not valid emails must be rejected.

## Notes

Local dummy data only. No login or payments.
