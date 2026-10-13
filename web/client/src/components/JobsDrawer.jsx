import React from 'react';

export default function JobsDrawer({ isOpen, onClose, jobs, currentJobId, onSelectJob, onRefresh }) {
  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.6)',
      backdropFilter: 'blur(4px)',
      zIndex: 90
    }} onClick={onClose}>
      <div
        className="glass-panel"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: '100%',
          maxWidth: '460px',
          borderRadius: 0,
          borderLeft: '1px solid var(--border-color)',
          display: 'flex',
          flexDirection: 'column',
          background: 'rgba(11, 15, 25, 0.95)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div style={{
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid var(--border-color)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#ffffff' }}>
              Test Runs History
            </h3>
            <span style={{
              fontSize: '0.75rem',
              background: 'rgba(255, 255, 255, 0.1)',
              padding: '0.15rem 0.5rem',
              borderRadius: 'var(--radius-full)',
              color: 'var(--text-muted)'
            }}>
              {jobs.length}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onRefresh}
              style={{ padding: '0.4rem 0.6rem', fontSize: '0.75rem' }}
              title="Refresh runs"
            >
              ↻ Refresh
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              style={{ padding: '0.4rem 0.6rem', fontSize: '0.75rem' }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Drawer Body / List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
          {jobs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-muted)' }}>
              No test jobs recorded yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {jobs.map((j) => {
                const isSelected = j.jobId === currentJobId;
                const timeStr = new Date(j.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const dateStr = new Date(j.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' });

                return (
                  <div
                    key={j.jobId}
                    onClick={() => {
                      onSelectJob(j.jobId);
                      onClose();
                    }}
                    style={{
                      background: isSelected ? 'rgba(99, 102, 241, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                      border: `1px solid ${isSelected ? 'var(--primary)' : 'var(--border-color)'}`,
                      borderRadius: 'var(--radius-md)',
                      padding: '1rem',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                      <span className={`badge badge-${j.status}`}>
                        <span className="pulse-dot" />
                        {j.status}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {dateStr} {timeStr}
                      </span>
                    </div>

                    <div style={{
                      fontWeight: 600,
                      fontSize: '0.9rem',
                      color: 'var(--text-primary)',
                      marginBottom: '0.25rem',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}>
                      {j.targetUrl}
                    </div>

                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Spec: {j.specFilename}
                    </div>

                    {j.statusMessage && (
                      <div style={{
                        fontSize: '0.75rem',
                        color: j.status === 'failed' ? '#fda4af' : 'var(--text-secondary)',
                        marginTop: '0.5rem',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}>
                        {j.statusMessage}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
