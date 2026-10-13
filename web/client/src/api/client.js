const API_BASE = '/api';

/**
 * Submit a new QA test job
 */
export async function submitTestJob({ url, specFile, answersFile }) {
  const formData = new FormData();
  formData.append('url', url);
  if (specFile) {
    formData.append('spec', specFile);
  }
  if (answersFile) {
    formData.append('answers', answersFile);
  }

  const response = await fetch(`${API_BASE}/tests`, {
    method: 'POST',
    body: formData
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to submit test job.');
  }

  return data;
}

/**
 * Fetch status, details, and logs of a test job
 */
export async function getJobStatus(jobId) {
  const response = await fetch(`${API_BASE}/tests/${jobId}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to fetch job status.');
  }
  return data;
}

/**
 * Fetch completed Markdown report
 */
export async function getJobReport(jobId) {
  const response = await fetch(`${API_BASE}/tests/${jobId}/report`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to fetch report.');
  }
  return data;
}

/**
 * Fetch pre-generated sample demo report
 */
export async function getDemoReport() {
  const response = await fetch(`${API_BASE}/demo-report`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to fetch demo report.');
  }
  return data;
}

/**
 * Fetch list of recent test jobs
 */
export async function getRecentJobs() {
  const response = await fetch(`${API_BASE}/tests`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to list recent jobs.');
  }
  return data.jobs || [];
}

/**
 * Request cancellation of a running or queued job
 */
export async function cancelJob(jobId) {
  const response = await fetch(`${API_BASE}/tests/${jobId}/cancel`, {
    method: 'POST'
  });
  return response.json();
}

/**
 * Retry a failed or completed job by creating a new job without overwriting previous results
 */
export async function retryJob(jobId) {
  const response = await fetch(`${API_BASE}/tests/${jobId}/retry`, {
    method: 'POST'
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to retry test job.');
  }
  return data;
}

/**
 * Helper to build download URL
 */
export function getDownloadUrl(jobId) {
  return `${API_BASE}/tests/${jobId}/download`;
}

/**
 * Helper to build evidence URL
 */
export function getEvidenceUrl(jobId, filename) {
  return `${API_BASE}/tests/${jobId}/evidence/${filename}`;
}
