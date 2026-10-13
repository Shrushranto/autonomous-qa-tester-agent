import React from 'react';

export default function SpecGuideModal({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(6px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100,
      padding: '1rem'
    }} onClick={onClose}>
      <div
        className="glass-panel animate-fade-in"
        style={{
          maxWidth: '750px',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: '2rem',
          position: 'relative'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{
              width: '34px',
              height: '34px',
              borderRadius: '8px',
              background: 'rgba(99, 102, 241, 0.15)',
              color: 'var(--primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
            </div>
            <h2 style={{ fontSize: '1.35rem', fontWeight: 700, color: '#ffffff' }}>
              Specification Guide
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary"
            style={{ padding: '0.4rem 0.65rem', borderRadius: '50%' }}
          >
            ✕
          </button>
        </div>

        <div className="markdown-body" style={{ fontSize: '0.925rem' }}>
          <p>
            The Autonomous QA Tester Agent uses <strong>Google Gemini</strong> to parse your Markdown specification into executable test plans and uses <strong>Playwright</strong> to autonomously interact with your web application.
          </p>

          <h3>1. What should a specification contain?</h3>
          <ul>
            <li><strong>Unique Rule Identifiers:</strong> Tag distinct rules using brackets like <code>[RULE-1]</code> or <code>[RULE-CART]</code>.</li>
            <li><strong>Expected Behaviors:</strong> Clearly define mathematical formulas, UI constraints, and expected responses.</li>
            <li><strong>Edge Cases:</strong> Explicitly note boundary conditions (e.g., negative quantities, promo codes, empty fields).</li>
          </ul>

          <h3>2. Specification Example</h3>
          <pre><code>{`# E-Commerce Web Application Specification

## 1. Product Catalog & Navigation
- [RULE-CATALOG-1] All products must display title, image, and price.
- [RULE-SEARCH-1] Search bar should filter products in real-time.

## 2. Shopping Cart Logic
- [RULE-CART-1] Cart total must equal sum of (price * quantity).
- [RULE-DISCOUNT-1] Applying code "SAVE10" must deduct 10% from subtotal.
- [RULE-CART-MAX] Quantity cannot exceed 99 items per product.

## 3. Checkout Form Validation
- [RULE-CHECKOUT-1] Submitting empty shipping form must display validation errors.
- [RULE-CHECKOUT-2] Invalid email format must be rejected.`}</code></pre>

          <h3>3. Optional Answers JSON (.json)</h3>
          <p>
            If your application has login screens or specific inputs (e.g. coupon codes, test accounts), you can provide a JSON file with pre-filled answers:
          </p>
          <pre><code>{`{
  "What is the test account email?": "qa-user@example.com",
  "What is the password?": "Secret123!",
  "What discount code should be tested?": "SAVE10"
}`}</code></pre>
        </div>

        <div style={{ marginTop: '1.5rem', textAlign: 'right' }}>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Got it, thanks!
          </button>
        </div>
      </div>
    </div>
  );
}
