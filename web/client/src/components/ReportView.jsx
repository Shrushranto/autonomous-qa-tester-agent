import React, { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getDownloadUrl, getEvidenceUrl } from '../api/client';

export default function ReportView({ jobId, targetUrl, specFilename, completedAt, markdown, onReset }) {
  // Parse metrics from the Markdown report
  const metrics = useMemo(() => {
    if (!markdown) return null;

    let total = 0;
    let confirmed = 0;
    let passed = 0;
    let inconclusive = 0;
    let unable = 0;
    let failed = 0;

    // Check for "Tests Attempted | X" or "Total Attempted | X" in summary table
    const totalMatch = markdown.match(/(?:Tests|Total)\s*Attempted\*{0,2}[^|]*\|\s*(\d+)/i);
    if (totalMatch) total = parseInt(totalMatch[1], 10);

    const confMatch = markdown.match(/Confirmed\s*Bugs\*{0,2}[^|]*\|\s*(\d+)/i);
    if (confMatch) confirmed = parseInt(confMatch[1], 10);

    const passMatch = markdown.match(/(?:Tests\s*)?Passed\*{0,2}[^|]*\|\s*(\d+)/i);
    if (passMatch) passed = parseInt(passMatch[1], 10);

    const failMatch = markdown.match(/(?:Tests\s*)?Failed\*{0,2}[^|]*\|\s*(\d+)/i);
    if (failMatch) failed = parseInt(failMatch[1], 10);

    const incMatch = markdown.match(/Inconclusive(?:\s*Findings)?\*{0,2}[^|]*\|\s*(\d+)/i);
    if (incMatch) inconclusive = parseInt(incMatch[1], 10);

    const unableMatch = markdown.match(/(?:Tests\s*)?Unable(?:\s*to\s*Complete)?\*{0,2}[^|]*\|\s*(\d+)/i);
    if (unableMatch) unable = parseInt(unableMatch[1], 10);

    // Fallback parsing from Test Execution Details table if summary table wasn't matched
    if (total === 0) {
      const testRows = markdown.match(/^\|\s*T\d+\s*\|/gmi);
      if (testRows) total = testRows.length;
    }

    if (confirmed === 0) {
      const confRows = markdown.match(/\|\s*Confirmed Bug\s*\|/gi);
      if (confRows) confirmed = confRows.length;
      else {
        const bugMatches = markdown.match(/###\s*\[?(?:BUG|RULE)[^\]\n]+\]?/gi);
        if (bugMatches) confirmed = bugMatches.length;
      }
    }

    if (passed === 0) {
      const passRows = markdown.match(/\|\s*Passed\s*\|/gi);
      if (passRows) passed = passRows.length;
    }

    return { total, confirmed, passed, inconclusive, unable, failed };
  }, [markdown]);

  // Render and sanitize Markdown HTML
  const sanitizedHtml = useMemo(() => {
    if (!markdown) return '';

    const renderer = new marked.Renderer();

    renderer.image = function (token) {
      let href = '';
      let text = '';
      let title = '';

      if (token && typeof token === 'object') {
        href = token.href || '';
        text = token.text || '';
        title = token.title || '';
      } else {
        // Fallback for positional signature
        href = arguments[0] || '';
        title = arguments[1] || '';
        text = arguments[2] || '';
      }

      if (href && !href.startsWith('http') && !href.startsWith('/')) {
        // Map relative filename (e.g. bug_r3.png) to backend evidence endpoint
        href = getEvidenceUrl(jobId, href);
      }

      const altAttr = text ? ` alt="${text}"` : ' alt="Bug Screenshot Evidence"';
      const titleAttr = title ? ` title="${title}"` : '';
      return `<div class="report-evidence-wrapper" style="margin: 1.25rem 0;"><img src="${href}"${altAttr}${titleAttr} class="report-evidence-img" style="max-width: 100%; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.15); box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35); display: block;" loading="lazy" /></div>`;
    };

    const rawHtml = marked.parse(markdown, { renderer, gfm: true, breaks: true });
    
    // Sanitize with DOMPurify
    return DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ['target', 'rel', 'style', 'loading'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed']
    });
  }, [markdown, jobId]);

  const downloadUrl = getDownloadUrl(jobId);

  return (
    <div className="animate-fade-in" style={{ maxWidth: '1000px', margin: '2rem auto' }}>
      {/* Top action bar */}
      <div className="glass-panel" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
              <span className="badge badge-completed">
                <span className="pulse-dot" />
                QA Report Ready
              </span>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Target: <strong style={{ color: 'var(--text-primary)' }}>{targetUrl}</strong>
              </span>
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Completed on: {completedAt ? new Date(completedAt).toLocaleString() : 'Just now'} • Spec: {specFilename}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <a
              id="download-report-btn"
              href={downloadUrl}
              download={`qa_report_${jobId.slice(0, 8)}.md`}
              className="btn btn-secondary"
              style={{ fontSize: '0.85rem' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Download Markdown Report
            </a>

            <button
              type="button"
              className="btn btn-primary"
              onClick={onReset}
              style={{ fontSize: '0.85rem' }}
            >
              Run New Test
            </button>
          </div>
        </div>

        {/* KPI Metric cards */}
        {metrics && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: '1rem',
            marginTop: '1.5rem',
            borderTop: '1px solid var(--border-color)',
            paddingTop: '1.25rem'
          }}>
            <div style={{
              background: 'rgba(255, 255, 255, 0.03)',
              borderRadius: 'var(--radius-md)',
              padding: '1rem',
              border: '1px solid var(--border-color)'
            }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
                Total Attempted
              </div>
              <div style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                {metrics.total || '-'}
              </div>
            </div>

            <div style={{
              background: 'rgba(244, 63, 94, 0.06)',
              borderRadius: 'var(--radius-md)',
              padding: '1rem',
              border: '1px solid rgba(244, 63, 94, 0.2)'
            }}>
              <div style={{ fontSize: '0.75rem', color: '#fda4af', textTransform: 'uppercase', fontWeight: 600 }}>
                Confirmed Bugs
              </div>
              <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#fb7185' }}>
                {metrics.confirmed}
              </div>
            </div>

            <div style={{
              background: 'rgba(16, 185, 129, 0.06)',
              borderRadius: 'var(--radius-md)',
              padding: '1rem',
              border: '1px solid rgba(16, 185, 129, 0.2)'
            }}>
              <div style={{ fontSize: '0.75rem', color: '#6ee7b7', textTransform: 'uppercase', fontWeight: 600 }}>
                Passed Tests
              </div>
              <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#34d399' }}>
                {metrics.passed}
              </div>
            </div>

            <div style={{
              background: 'rgba(245, 158, 11, 0.06)',
              borderRadius: 'var(--radius-md)',
              padding: '1rem',
              border: '1px solid rgba(245, 158, 11, 0.2)'
            }}>
              <div style={{ fontSize: '0.75rem', color: '#fcd34d', textTransform: 'uppercase', fontWeight: 600 }}>
                Inconclusive / Other
              </div>
              <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#fbbf24' }}>
                {metrics.inconclusive + metrics.unable}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Rendered Markdown Body */}
      <div className="glass-panel" style={{ padding: '2.5rem' }}>
        <div
          className="markdown-body"
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
      </div>
    </div>
  );
}
