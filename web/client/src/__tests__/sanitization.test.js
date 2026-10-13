import { describe, it, expect } from 'vitest';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

describe('Markdown Report Sanitization & XSS Prevention', () => {
  function renderAndSanitize(markdown) {
    const rawHtml = marked.parse(markdown, { gfm: true });
    return DOMPurify.sanitize(rawHtml, {
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed']
    });
  }

  it('strips <script> tags completely', () => {
    const malicious = '# Bug Report\n<script>alert("pwned")</script>\nNormal text';
    const clean = renderAndSanitize(malicious);
    expect(clean).not.toContain('<script>');
    expect(clean).not.toContain('alert("pwned")');
    expect(clean).toContain('Normal text');
  });

  it('neutralizes onerror attributes on img tags', () => {
    const malicious = '<img src="x" onerror="alert(1)">';
    const clean = renderAndSanitize(malicious);
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('alert(1)');
  });

  it('removes javascript: scheme from links', () => {
    const malicious = '[Click here](javascript:alert("xss"))';
    const clean = renderAndSanitize(malicious);
    expect(clean).not.toContain('javascript:');
  });

  it('removes iframe, embed, and object tags', () => {
    const malicious = '<iframe src="https://evil.com"></iframe><embed src="malware.swf">';
    const clean = renderAndSanitize(malicious);
    expect(clean).not.toContain('<iframe');
    expect(clean).not.toContain('<embed');
  });

  it('preserves legitimate Markdown tables, headers, lists, and formatting', () => {
    const reportMd = `
# Autonomous QA Test Report
## 1. Executive Summary

| Metric | Count |
| :--- | :--- |
| **Total Attempted** | 5 |
| **Confirmed Bugs** | 2 |

### [BUG-1] Cart Total Mismatch
1. Add item to cart
2. Check total
- **Expected:** $25.00
- **Actual:** $35.00
`;
    const clean = renderAndSanitize(reportMd);
    expect(clean).toContain('Autonomous QA Test Report');
    expect(clean).toContain('<table>');
    expect(clean).toContain('Total Attempted');
    expect(clean).toContain('Cart Total Mismatch');
    expect(clean).toContain('<strong>Expected:</strong>');
  });
});
