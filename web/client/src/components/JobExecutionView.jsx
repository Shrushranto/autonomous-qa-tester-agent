import React, { useEffect, useRef, useState } from 'react';
import { cancelJob } from '../api/client';

export default function JobExecutionView({ job, onJobUpdated, onReset, onRetry }) {
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const terminalEndRef = useRef(null);

  // Auto-scroll terminal to bottom as new logs arrive
  useEffect(() => {
    if (terminalEndRef.current && typeof terminalEndRef.current.scrollIntoView === 'function') {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [job?.logs?.length]);

  // Track elapsed time
  useEffect(() => {
    if (!job?.createdAt) return;
    const start = new Date(job.startedAt || job.createdAt).getTime();

    const updateTimer = () => {
      const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
      setElapsed(Math.max(0, Math.floor((end - start) / 1000)));
    };

    updateTimer();
    if (job.status === 'queued' || job.status === 'running') {
      const timer = setInterval(updateTimer, 1000);
      return () => clearInterval(timer);
    }
  }, [job?.status, job?.createdAt, job?.startedAt, job?.completedAt]);

  const handleCancel = async () => {
    if (!window.confirm('Are you sure you want to cancel this test execution?')) return;
    try {
      setCancelling(true);
      await cancelJob(job.jobId);
    } catch (err) {
      console.error('Failed to cancel job:', err);
    } finally {
      setCancelling(false);
    }
  };

  const handleRetry = async () => {
    if (retrying || !onRetry) return;
    try {
      setRetrying(true);
      await onRetry(job.jobId);
    } catch (err) {
      alert(`Retry failed: ${err.message}`);
    } finally {
      setRetrying(false);
    }
  };

  const formatSeconds = (sec) => {
    const mins = Math.floor(sec / 60);
    const s = sec % 60;
    return `${mins}m ${s < 10 ? '0' : ''}${s}s`;
  };

  const errorCode = job?.error?.code;
  const isRetryable = job?.retryable !== false;

  return (
    <div className="animate-fade-in" style={{ maxWidth: '900px', margin: '2rem auto' }}>
      {/* Header card with status */}
      <div className="glass-panel" style={{ padding: '1.75rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Job ID:</span>
              <code style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.85rem',
                color: 'var(--accent-cyan)',
                background: 'rgba(56, 189, 248, 0.1)',
                padding: '0.2rem 0.5rem',
                borderRadius: 'var(--radius-sm)'
              }}>
                {job?.jobId}
              </code>
              <span className={`badge badge-${job?.status}`}>
                <span className="pulse-dot" />
                {job?.status}
              </span>
            </div>
            <div style={{ fontSize: '0.95rem', color: 'var(--text-secondary)' }}>
              Target: <strong style={{ color: 'var(--text-primary)' }}>{job?.targetUrl}</strong>
              <span style={{ margin: '0 0.5rem' }}>•</span>
              Spec: <strong style={{ color: 'var(--text-primary)' }}>{job?.specFilename}</strong>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{
              background: 'rgba(255, 255, 255, 0.04)',
              padding: '0.5rem 0.85rem',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-color)',
              fontSize: '0.825rem',
              color: 'var(--text-muted)'
            }}>
              Duration: <strong style={{ color: 'var(--text-primary)' }}>{formatSeconds(elapsed)}</strong>
            </div>

            {(job?.status === 'running' || job?.status === 'queued') && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleCancel}
                disabled={cancelling}
                style={{ fontSize: '0.8rem', padding: '0.5rem 0.85rem' }}
              >
                {cancelling ? 'Cancelling...' : 'Cancel Run'}
              </button>
            )}

            {(job?.status === 'completed' || job?.status === 'failed') && (
              <>
                {job?.status === 'failed' && isRetryable && onRetry && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleRetry}
                    disabled={retrying}
                    style={{ fontSize: '0.8rem', padding: '0.5rem 0.95rem' }}
                  >
                    {retrying ? 'Retrying...' : '↻ Retry Test'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onReset}
                  style={{ fontSize: '0.8rem', padding: '0.5rem 0.85rem' }}
                >
                  Run Another Test
                </button>
              </>
            )}
          </div>
        </div>

        {/* Failed Error Panel */}
        {job?.status === 'failed' && (
          <div style={{
            marginTop: '1.25rem',
            padding: '1.25rem',
            borderRadius: 'var(--radius-md)',
            background: 'rgba(244, 63, 94, 0.08)',
            border: '1px solid rgba(244, 63, 94, 0.3)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span style={{ fontWeight: 700, color: '#fb7185', fontSize: '0.95rem' }}>
                Test Execution Failed
              </span>
              {errorCode && (
                <span style={{
                  fontSize: '0.7rem',
                  fontFamily: 'var(--font-mono)',
                  background: 'rgba(244, 63, 94, 0.2)',
                  color: '#fda4af',
                  padding: '0.15rem 0.5rem',
                  borderRadius: 'var(--radius-sm)',
                  fontWeight: 600
                }}>
                  {errorCode}
                </span>
              )}
            </div>

            <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: '0.5rem', lineHeight: 1.5 }}>
              {job?.error?.message || job?.errorMessage || 'The test agent stopped unexpectedly.'}
            </div>

            {/* Error Guidance */}
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              {errorCode === 'GEMINI_UNAVAILABLE' && (
                <span>Next step: The AI model experienced a demand spike. Click <strong>Retry Test</strong> to rerun with a fresh job ID.</span>
              )}
              {errorCode === 'GEMINI_RATE_LIMITED' && (
                <span>Next step: Quota has been reached. Please wait a few moments before triggering another test.</span>
              )}
              {errorCode === 'GEMINI_AUTH_ERROR' && (
                <span style={{ color: '#fda4af' }}>Next step: Please check your <code>GEMINI_API_KEY</code> configuration in your <code>.env</code> file. Automatic retry is disabled.</span>
              )}
              {errorCode === 'EXECUTION_TIMEOUT' && (
                <span>Next step: Execution was halted by the watchdog timeout. Check if the target website was responsive.</span>
              )}
              {errorCode === 'REPORT_NOT_GENERATED' && (
                <span>Next step: The agent completed its run but did not generate a final report. Inspect logs below.</span>
              )}
              {(!errorCode || errorCode === 'AGENT_EXECUTION_FAILED') && (
                <span>Next step: Review the agent logs below for diagnostic details, or click <strong>Retry Test</strong>.</span>
              )}
            </div>
          </div>
        )}

        {/* Running / Queued Status Banner */}
        {job?.status !== 'failed' && (
          <div style={{
            marginTop: '1.25rem',
            padding: '0.85rem 1rem',
            borderRadius: 'var(--radius-md)',
            background: job?.status === 'completed' ? 'rgba(16, 185, 129, 0.08)' : 'rgba(99, 102, 241, 0.08)',
            border: `1px solid ${job?.status === 'completed' ? 'rgba(16, 185, 129, 0.25)' : 'rgba(99, 102, 241, 0.25)'}`,
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem'
          }}>
            {job?.status === 'running' && (
              <div className="pulse-dot" style={{ background: '#fbbf24', flexShrink: 0 }} />
            )}
            {job?.status === 'queued' && (
              <div className="pulse-dot" style={{ background: '#38bdf8', flexShrink: 0 }} />
            )}
            {job?.status === 'completed' && (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            )}

            <div style={{ fontSize: '0.9rem', color: 'var(--text-primary)', flex: 1 }}>
              {job?.statusMessage || 'Processing test job...'}
            </div>
          </div>
        )}

        {/* In-progress notice about bounded retries */}
        {(job?.status === 'running' || job?.status === 'queued') && (
          <div style={{ fontSize: '0.775rem', color: 'var(--text-muted)', marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
            <span>Autonomous testing active. The AI agent automatically retries transient Gemini service interruptions with bounded exponential backoff.</span>
          </div>
        )}
      </div>

      {/* Terminal window showing honest real-time logs */}
      <div className="terminal-window">
        <div className="terminal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="terminal-dots">
              <span />
              <span />
              <span />
            </div>
            <span>Agent Process Logs (Python child process)</span>
          </div>
          <div>
            {job?.logs?.length || 0} entries
          </div>
        </div>

        <div className="terminal-body">
          {(!job?.logs || job.logs.length === 0) ? (
            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Waiting for agent stdout/stderr output...
            </div>
          ) : (
            job.logs.map((log, idx) => {
              const time = new Date(log.timestamp).toLocaleTimeString();
              const streamClass = `log-text-${log.stream || 'stdout'}`;
              return (
                <div key={idx} className="log-entry">
                  <span className="log-time">[{time}]</span>
                  <span className={streamClass}>{log.text}</span>
                </div>
              );
            })
          )}
          <div ref={terminalEndRef} />
        </div>
      </div>
    </div>
  );
}
