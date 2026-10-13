import React, { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import TestForm from './components/TestForm';
import JobExecutionView from './components/JobExecutionView';
import ReportView from './components/ReportView';
import SpecGuideModal from './components/SpecGuideModal';
import JobsDrawer from './components/JobsDrawer';
import { submitTestJob, getJobStatus, getJobReport, getDemoReport, getRecentJobs, retryJob } from './api/client';

export default function App() {
  const [view, setView] = useState('form'); // 'form' | 'execution' | 'report'
  const [currentJob, setCurrentJob] = useState(null);
  const [reportData, setReportData] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [recentJobs, setRecentJobs] = useState([]);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  // Fetch recent jobs
  const refreshRecentJobs = useCallback(async () => {
    try {
      const list = await getRecentJobs();
      setRecentJobs(list);
    } catch (e) {
      console.warn('Could not fetch recent jobs:', e);
    }
  }, []);

  useEffect(() => {
    refreshRecentJobs();
  }, [refreshRecentJobs]);

  // Count active jobs
  const activeCount = recentJobs.filter(j => j.status === 'queued' || j.status === 'running').length;

  // Poll current job if queued or running
  useEffect(() => {
    if (!currentJob?.jobId) return;
    if (currentJob.status !== 'queued' && currentJob.status !== 'running') return;

    let isMounted = true;
    const interval = setInterval(async () => {
      try {
        const updated = await getJobStatus(currentJob.jobId);
        if (!isMounted) return;

        setCurrentJob(updated);

        // If completed, fetch report and transition
        if (updated.status === 'completed' && updated.reportAvailable) {
          clearInterval(interval);
          try {
            const report = await getJobReport(currentJob.jobId);
            if (isMounted) {
              setReportData(report);
              setView('report');
              refreshRecentJobs();
            }
          } catch (rErr) {
            console.error('Failed to load report:', rErr);
          }
        } else if (updated.status === 'failed') {
          clearInterval(interval);
          refreshRecentJobs();
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 1800);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [currentJob?.jobId, currentJob?.status, refreshRecentJobs]);

  // Handle Form Submission
  const handleFormSubmit = async ({ url, specFile, answersFile }) => {
    setIsSubmitting(true);
    try {
      const result = await submitTestJob({ url, specFile, answersFile });
      const initialJob = await getJobStatus(result.jobId);
      setCurrentJob(initialJob);
      setView('execution');
      refreshRecentJobs();
    } catch (err) {
      alert(`Error submitting job: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // View pre-generated Demo Report
  const handleViewDemoReport = async () => {
    try {
      const demo = await getDemoReport();
      setReportData(demo);
      setCurrentJob({
        jobId: demo.jobId,
        targetUrl: demo.targetUrl,
        specFilename: demo.specFilename,
        status: 'completed',
        reportAvailable: true
      });
      setView('report');
      refreshRecentJobs();
    } catch (err) {
      alert(`Error loading demo report: ${err.message}`);
    }
  };

  // Select job from history drawer
  const handleSelectJob = async (jobId) => {
    try {
      const job = await getJobStatus(jobId);
      setCurrentJob(job);

      if (job.status === 'completed' && job.reportAvailable) {
        const report = await getJobReport(jobId);
        setReportData(report);
        setView('report');
      } else {
        setView('execution');
      }
    } catch (err) {
      alert(`Error loading job ${jobId}: ${err.message}`);
    }
  };

  // Handle Retrying a Failed Job
  const handleRetryJob = async (jobId) => {
    try {
      const result = await retryJob(jobId);
      const initialJob = await getJobStatus(result.jobId);
      setCurrentJob(initialJob);
      setView('execution');
      refreshRecentJobs();
    } catch (err) {
      alert(`Error retrying job: ${err.message}`);
    }
  };

  const handleReset = () => {
    setCurrentJob(null);
    setReportData(null);
    setView('form');
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header
        onNewTest={handleReset}
        onViewDemoReport={handleViewDemoReport}
        onOpenHistory={() => setIsHistoryOpen(true)}
        onOpenGuide={() => setIsGuideOpen(true)}
        activeCount={activeCount}
      />

      <main style={{ flex: 1, padding: '1.5rem 0' }}>
        <div className="container">
          {view === 'form' && (
            <TestForm
              onSubmit={handleFormSubmit}
              isSubmitting={isSubmitting}
              onViewDemoReport={handleViewDemoReport}
            />
          )}

          {view === 'execution' && (
            <JobExecutionView
              job={currentJob}
              onJobUpdated={setCurrentJob}
              onReset={handleReset}
              onRetry={handleRetryJob}
            />
          )}

          {view === 'report' && reportData && (
            <ReportView
              jobId={reportData.jobId}
              targetUrl={reportData.targetUrl}
              specFilename={reportData.specFilename}
              completedAt={reportData.completedAt}
              markdown={reportData.reportMarkdown}
              onReset={handleReset}
            />
          )}
        </div>
      </main>

      {/* Footer */}
      <footer style={{
        borderTop: '1px solid var(--border-color)',
        padding: '1.5rem 0',
        textAlign: 'center',
        fontSize: '0.8rem',
        color: 'var(--text-muted)'
      }}>
        <div className="container">
          Autonomous QA Tester • Powered by Gemini & Playwright (Python Engine) • MERN Architecture
        </div>
      </footer>

      {/* Modals and Drawers */}
      <SpecGuideModal
        isOpen={isGuideOpen}
        onClose={() => setIsGuideOpen(false)}
      />

      <JobsDrawer
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        jobs={recentJobs}
        currentJobId={currentJob?.jobId}
        onSelectJob={handleSelectJob}
        onRefresh={refreshRecentJobs}
      />
    </div>
  );
}
