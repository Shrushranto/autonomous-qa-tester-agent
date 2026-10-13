import React, { useState, useRef } from 'react';

export default function TestForm({ onSubmit, isSubmitting, onViewDemoReport }) {
  const [url, setUrl] = useState('');
  const [specFile, setSpecFile] = useState(null);
  const [answersFile, setAnswersFile] = useState(null);
  const [error, setError] = useState(null);

  const specInputRef = useRef(null);
  const answersInputRef = useRef(null);

  const handleSpecChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.name.endsWith('.md') && !file.name.endsWith('.markdown')) {
      setError('Specification file must be a Markdown (.md) document.');
      setSpecFile(null);
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setError('Specification file size exceeds the 2MB limit.');
      setSpecFile(null);
      return;
    }

    setError(null);
    setSpecFile(file);
  };

  const handleAnswersChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.name.endsWith('.json')) {
      setError('Answers file must be a JSON (.json) document.');
      setAnswersFile(null);
      return;
    }

    if (file.size > 1024 * 1024) {
      setError('Answers file size exceeds the 1MB limit.');
      setAnswersFile(null);
      return;
    }

    setError(null);
    setAnswersFile(file);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setError(null);

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError('Please provide a target website URL.');
      return;
    }

    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError('URL must start with http:// or https://');
        return;
      }
    } catch {
      setError('Please enter a valid website URL (e.g., http://localhost:3000 or https://example.com).');
      return;
    }

    if (!specFile) {
      setError('Please upload a specification Markdown (.md) file.');
      return;
    }

    onSubmit({
      url: trimmedUrl,
      specFile,
      answersFile
    });
  };

  // Demo Shop Quick Preset
  const handleQuickLoadDemo = async () => {
    setUrl('http://localhost:3000');
    setError(null);

    try {
      // Create a demo specification blob from typical shop spec
      const demoSpecContent = `# Demo Shop Specification

## Rule 1: Cart Calculation
- [RULE-1] The subtotal must equal the exact sum of all item prices multiplied by their quantities.
- [RULE-1-DISCOUNT] Applying a valid discount code must reduce the total correctly.
- Expected behavior: Cart total matches calculated math.

## Rule 2: Checkout Validation
- [RULE-2] Submitting checkout with an empty name or email must trigger visible validation errors.
- Expected behavior: Form cannot be submitted with missing required fields.

## Rule 3: Search Functionality
- [RULE-3] Searching for an existing product title must display the item in results.
- Expected behavior: Products matching query appear in the list.
`;
      const blob = new Blob([demoSpecContent], { type: 'text/markdown' });
      const file = new File([blob], 'demo_shop_spec.md', { type: 'text/markdown' });
      setSpecFile(file);

      // Optional answers demo
      const demoAnswers = {
        "What is the discount code?": "SAVE10",
        "What email should be used?": "tester@example.com"
      };
      const ansBlob = new Blob([JSON.stringify(demoAnswers, null, 2)], { type: 'application/json' });
      const ansFile = new File([ansBlob], 'demo_answers.json', { type: 'application/json' });
      setAnswersFile(ansFile);
    } catch (err) {
      console.warn('Could not populate demo preset:', err);
    }
  };

  return (
    <div className="animate-fade-in" style={{ maxWidth: '800px', margin: '2rem auto' }}>
      {/* Hero title */}
      <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
        <h1 style={{
          fontSize: '2.5rem',
          fontWeight: 800,
          letterSpacing: '-0.03em',
          background: 'linear-gradient(135deg, #ffffff 40%, #94a3b8 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          marginBottom: '0.75rem'
        }}>
          Autonomous QA Tester
        </h1>
        <p style={{ fontSize: '1.05rem', color: 'var(--text-secondary)', maxWidth: '600px', margin: '0 auto' }}>
          Autonomous web testing powered by Gemini API, Playwright browser automation, and rigorous bug reproduction.
        </p>

        <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={handleQuickLoadDemo}
            className="btn btn-secondary"
            style={{
              fontSize: '0.8rem',
              padding: '0.4rem 0.85rem',
              borderRadius: 'var(--radius-full)',
              color: 'var(--accent-cyan)',
              borderColor: 'rgba(56, 189, 248, 0.25)'
            }}
          >
            ⚡ Quick Load Demo Shop Preset (localhost:3000)
          </button>

          {onViewDemoReport && (
            <button
              type="button"
              onClick={onViewDemoReport}
              className="btn btn-secondary"
              style={{
                fontSize: '0.8rem',
                padding: '0.4rem 0.85rem',
                borderRadius: 'var(--radius-full)',
                color: '#a5b4fc',
                borderColor: 'rgba(99, 102, 241, 0.3)'
              }}
            >
              📄 Preview Sample Demo Report
            </button>
          )}
        </div>
      </div>

      {/* Main Form Card */}
      <div className="glass-panel" style={{ padding: '2.25rem' }}>
        <form onSubmit={handleSubmit}>
          {error && (
            <div style={{
              background: 'rgba(244, 63, 94, 0.1)',
              border: '1px solid rgba(244, 63, 94, 0.3)',
              borderRadius: 'var(--radius-md)',
              padding: '0.85rem 1.15rem',
              marginBottom: '1.5rem',
              color: '#fda4af',
              fontSize: '0.9rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem'
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>{error}</span>
            </div>
          )}

          {/* Target Website URL */}
          <div className="form-group">
            <label className="form-label" htmlFor="target-url">
              Target Website URL <span style={{ color: 'var(--accent-rose)' }}>*</span>
            </label>
            <input
              id="target-url"
              type="text"
              className="input-text"
              placeholder="e.g. http://localhost:3000 or https://your-website.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={isSubmitting}
            />
            <div className="form-hint">
              Enter the full HTTP/HTTPS URL of the website to test. Local development targets (e.g. http://localhost:3000) are permitted.
            </div>
          </div>

          {/* Specification File Upload */}
          <div className="form-group">
            <label className="form-label">
              Specification Markdown (.md) <span style={{ color: 'var(--accent-rose)' }}>*</span>
            </label>
            <div
              className={`file-dropzone ${specFile ? 'active' : ''}`}
              onClick={() => specInputRef.current?.click()}
            >
              <input
                ref={specInputRef}
                type="file"
                accept=".md,.markdown"
                onChange={handleSpecChange}
                disabled={isSubmitting}
              />
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{
                  width: '42px',
                  height: '42px',
                  borderRadius: '10px',
                  background: 'rgba(99, 102, 241, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--primary)'
                }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="16" y1="13" x2="8" y2="13"></line>
                    <line x1="16" y1="17" x2="8" y2="17"></line>
                    <polyline points="10 9 9 9 8 9"></polyline>
                  </svg>
                </div>
                {specFile ? (
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--accent-emerald)' }}>✓ {specFile.name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {(specFile.size / 1024).toFixed(1)} KB — Click to change file
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                      Click to upload or drag & drop specification Markdown
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Markdown (.md) up to 2MB. Should contain functional rules [RULE-X].
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Optional Answers File Upload */}
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <label className="form-label" style={{ marginBottom: 0 }}>
                Optional Clarifications / Answers JSON (.json)
              </label>
              {answersFile && (
                <button
                  type="button"
                  onClick={() => setAnswersFile(null)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.75rem', cursor: 'pointer' }}
                >
                  Clear file
                </button>
              )}
            </div>
            <div
              className={`file-dropzone ${answersFile ? 'active' : ''}`}
              onClick={() => answersInputRef.current?.click()}
              style={{ padding: '1rem' }}
            >
              <input
                ref={answersInputRef}
                type="file"
                accept=".json"
                onChange={handleAnswersChange}
                disabled={isSubmitting}
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"></path>
                </svg>
                {answersFile ? (
                  <div style={{ fontSize: '0.85rem', color: 'var(--accent-cyan)' }}>
                    ✓ {answersFile.name} ({(answersFile.size / 1024).toFixed(1)} KB)
                  </div>
                ) : (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    Optional: Pre-answered credentials, test tokens, or clarification answers (.json)
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Submit Button */}
          <div style={{ marginTop: '2rem' }}>
            <button
              id="generate-report-btn"
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting}
              style={{ width: '100%', padding: '0.9rem', fontSize: '1rem', fontWeight: 600 }}
            >
              {isSubmitting ? (
                <>
                  <span className="pulse-dot" style={{ background: '#ffffff' }} />
                  Initializing Autonomous Agent...
                </>
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                  </svg>
                  Generate Report
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
