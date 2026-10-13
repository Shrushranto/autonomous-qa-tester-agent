import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import JobExecutionView from '../components/JobExecutionView';
import ReportView from '../components/ReportView';

describe('Frontend Error Handling & Report Rendering Tests', () => {
  it('Item 8: Correctly displays failed job with error code, friendly message, and retry button when retryable', () => {
    const handleRetry = vi.fn();
    const handleReset = vi.fn();

    const failedJob = {
      jobId: 'failed-job-503',
      targetUrl: 'http://localhost:3000',
      specFilename: 'shop.md',
      status: 'failed',
      statusMessage: 'The AI model is temporarily overloaded.',
      error: {
        code: 'GEMINI_UNAVAILABLE',
        message: 'The AI model is temporarily overloaded. The agent retried the request but could not complete it. Please try again shortly.'
      },
      retryable: true,
      logs: [{ timestamp: new Date(), text: '503 Service Unavailable', stream: 'stderr' }]
    };

    render(
      <JobExecutionView
        job={failedJob}
        onJobUpdated={vi.fn()}
        onReset={handleReset}
        onRetry={handleRetry}
      />
    );

    // Verify error panel and code
    expect(screen.getByText(/Test Execution Failed/i)).toBeDefined();
    expect(screen.getByText(/GEMINI_UNAVAILABLE/i)).toBeDefined();
    expect(screen.getByText(/The AI model is temporarily overloaded/i)).toBeDefined();

    // Verify retry button is shown
    const retryBtn = screen.getByRole('button', { name: /Retry Test/i });
    expect(retryBtn).toBeDefined();

    fireEvent.click(retryBtn);
    expect(handleRetry).toHaveBeenCalledWith('failed-job-503');
  });

  it('Item 8: Hides retry button and displays configuration guidance when failure is non-retryable (e.g. GEMINI_AUTH_ERROR)', () => {
    const handleRetry = vi.fn();
    const handleReset = vi.fn();

    const authFailedJob = {
      jobId: 'failed-job-auth',
      targetUrl: 'http://localhost:3000',
      specFilename: 'shop.md',
      status: 'failed',
      statusMessage: 'The AI service configuration is invalid.',
      error: {
        code: 'GEMINI_AUTH_ERROR',
        message: 'The AI service configuration is invalid. Please contact the administrator.'
      },
      retryable: false,
      logs: []
    };

    render(
      <JobExecutionView
        job={authFailedJob}
        onJobUpdated={vi.fn()}
        onReset={handleReset}
        onRetry={handleRetry}
      />
    );

    // Verify error code and message
    expect(screen.getByText(/GEMINI_AUTH_ERROR/i)).toBeDefined();
    expect(screen.getByText(/GEMINI_API_KEY/i)).toBeDefined();
    expect(screen.getByText(/Automatic retry is disabled/i)).toBeDefined();

    // Verify retry button is NOT rendered
    const retryBtn = screen.queryByRole('button', { name: /Retry Test/i });
    expect(retryBtn).toBeNull();

    // Run Another Test button should still be available
    expect(screen.getByRole('button', { name: /Run Another Test/i })).toBeDefined();
  });

  it('Item 9: Correctly displays a completed job with KPI cards, report markdown, and download button', () => {
    const handleReset = vi.fn();
    const markdown = `
# QA Test Report
## 1. Executive Summary

| Metric | Count |
| :--- | :--- |
| **Total Attempted** | 5 |
| **Confirmed Bugs** | 3 |
| **Passed** | 2 |

### [BUG-1] Invalid Quantity Accepted
- Expected: Qty >= 1
- Actual: Qty -1 accepted
`;

    render(
      <ReportView
        jobId="completed-job-123"
        targetUrl="http://localhost:3000"
        specFilename="shop.md"
        completedAt="2026-10-14T01:00:00Z"
        markdown={markdown}
        onReset={handleReset}
      />
    );

    // Verify header status and title
    expect(screen.getByText(/QA Report Ready/i)).toBeDefined();
    expect(screen.getByText(/http:\/\/localhost:3000/i)).toBeDefined();

    // Verify parsed KPI metrics cards
    expect(screen.getAllByText('5').length).toBeGreaterThanOrEqual(1); // Total Attempted
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1); // Confirmed Bugs
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1); // Passed Tests

    // Verify report body
    expect(screen.getByText(/QA Test Report/i)).toBeDefined();
    expect(screen.getByText(/Invalid Quantity Accepted/i)).toBeDefined();

    // Verify download button
    const dlBtn = screen.getByRole('link', { name: /Download Markdown Report/i });
    expect(dlBtn).toBeDefined();
    expect(dlBtn.getAttribute('href')).toContain('/api/tests/completed-job-123/download');
  });
});
