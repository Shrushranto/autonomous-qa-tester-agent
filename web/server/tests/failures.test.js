const request = require('supertest');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const app = require('../src/app');
const Job = require('../src/models/Job');

const TEST_DB = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/qa_tester_test';

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
});

afterAll(async () => {
  await Job.deleteMany({});
  await mongoose.connection.close();
});

beforeEach(async () => {
  await Job.deleteMany({});
});

describe('Failure Handling & Error Classification Integration Tests', () => {
  test('Item 5: Python agent exiting with exit code 10 classifies as GEMINI_UNAVAILABLE and is retryable', async () => {
    const job = await Job.create({
      jobId: 'job-err-503',
      targetUrl: 'http://localhost:3000',
      specFilename: 'shop.md',
      specPath: 'dummy/path',
      reportPath: 'dummy/report.md',
      status: 'failed',
      statusMessage: 'The AI model is temporarily overloaded.',
      error: {
        code: 'GEMINI_UNAVAILABLE',
        message: 'The AI model is temporarily overloaded. The agent retried the request but could not complete it. Please try again shortly.',
        detail: 'Exit code 10'
      },
      retryable: true,
      reportAvailable: false
    });

    const res = await request(app).get(`/api/tests/${job.jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error.code).toBe('GEMINI_UNAVAILABLE');
    expect(res.body.retryable).toBe(true);
    expect(res.body.reportAvailable).toBe(false);
  });

  test('Item 5: Python agent exiting with exit code 12 classifies as GEMINI_AUTH_ERROR and is NOT retryable', async () => {
    const job = await Job.create({
      jobId: 'job-err-auth',
      targetUrl: 'http://localhost:3000',
      specFilename: 'shop.md',
      specPath: 'dummy/path',
      reportPath: 'dummy/report.md',
      status: 'failed',
      statusMessage: 'The AI service configuration is invalid.',
      error: {
        code: 'GEMINI_AUTH_ERROR',
        message: 'The AI service configuration is invalid. Please contact the administrator.',
        detail: 'Exit code 12'
      },
      retryable: false,
      reportAvailable: false
    });

    const res = await request(app).get(`/api/tests/${job.jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error.code).toBe('GEMINI_AUTH_ERROR');
    expect(res.body.retryable).toBe(false);

    // Attempting to retry a non-retryable job returns 400
    const retryRes = await request(app).post(`/api/tests/${job.jobId}/retry`);
    expect(retryRes.status).toBe(400);
    expect(retryRes.body.error).toMatch(/non-retryable error/i);
  });

  test('Item 6: Python agent exiting successfully (0) but generating no report classifies as REPORT_NOT_GENERATED', async () => {
    const job = await Job.create({
      jobId: 'job-err-missing-report',
      targetUrl: 'http://localhost:3000',
      specFilename: 'shop.md',
      specPath: 'dummy/path',
      reportPath: 'dummy/non_existent_report.md',
      status: 'failed',
      statusMessage: 'Testing stopped, but the report could not be generated.',
      error: {
        code: 'REPORT_NOT_GENERATED',
        message: 'Testing stopped, but the report could not be generated. Please check the run details before retrying.',
        detail: 'Process exited with code 0 but no report file was generated.'
      },
      retryable: true,
      reportAvailable: false
    });

    const res = await request(app).get(`/api/tests/${job.jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error.code).toBe('REPORT_NOT_GENERATED');
    expect(res.body.reportAvailable).toBe(false);

    const reportRes = await request(app).get(`/api/tests/${job.jobId}/report`);
    expect(reportRes.status).toBe(404);
  });

  test('Item 7: Execution timeout classifies as EXECUTION_TIMEOUT and is retryable', async () => {
    const job = await Job.create({
      jobId: 'job-err-timeout',
      targetUrl: 'http://localhost:3000',
      specFilename: 'shop.md',
      specPath: 'dummy/path',
      reportPath: 'dummy/report.md',
      status: 'failed',
      statusMessage: 'The test exceeded its allowed runtime and was stopped.',
      error: {
        code: 'EXECUTION_TIMEOUT',
        message: 'The test exceeded its allowed runtime and was stopped.',
        detail: 'Child process exceeded maximum execution timeout.'
      },
      retryable: true,
      reportAvailable: false
    });

    const res = await request(app).get(`/api/tests/${job.jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error.code).toBe('EXECUTION_TIMEOUT');
    expect(res.body.retryable).toBe(true);
  });

  test('Item 10: Retrying a failed job creates a new job without overwriting previous job files or records', async () => {
    // Setup a dummy source spec file in uploads
    const oldJobId = 'job-original-fail';
    const originalUploadDir = path.resolve(__dirname, '../uploads', oldJobId);
    fs.mkdirSync(originalUploadDir, { recursive: true });
    const originalSpecFile = path.join(originalUploadDir, 'spec.md');
    fs.writeFileSync(originalSpecFile, '# Spec for Retry Test');

    const originalReportDir = path.resolve(__dirname, '../../../reports/jobs', oldJobId);
    fs.mkdirSync(originalReportDir, { recursive: true });
    const originalReportFile = path.join(originalReportDir, 'report.md');
    fs.writeFileSync(originalReportFile, '# Incomplete Report');

    const oldJob = await Job.create({
      jobId: oldJobId,
      targetUrl: 'http://localhost:3000',
      specFilename: 'shop.md',
      specPath: originalSpecFile,
      reportPath: originalReportFile,
      status: 'failed',
      statusMessage: 'Overloaded',
      error: {
        code: 'GEMINI_UNAVAILABLE',
        message: 'Overloaded'
      },
      retryable: true
    });

    // Request retry
    const res = await request(app).post(`/api/tests/${oldJob.jobId}/retry`);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('jobId');
    expect(res.body.jobId).not.toBe(oldJob.jobId);
    expect(res.body.status).toBe('queued');

    // Verify original job record is intact and unchanged
    const originalAfter = await Job.findOne({ jobId: oldJobId });
    expect(originalAfter.status).toBe('failed');
    expect(originalAfter.jobId).toBe(oldJobId);

    // Verify new job record exists with new isolated paths
    const newJob = await Job.findOne({ jobId: res.body.jobId });
    expect(newJob).not.toBeNull();
    expect(newJob.targetUrl).toBe('http://localhost:3000');
    expect(newJob.reportPath).toContain(newJob.jobId);
    expect(newJob.specPath).toContain(newJob.jobId);

    // Verify original spec file was not removed
    expect(fs.existsSync(originalSpecFile)).toBe(true);

    // Clean up test directories
    fs.rmSync(originalUploadDir, { recursive: true, force: true });
    fs.rmSync(originalReportDir, { recursive: true, force: true });
    const newUploadDir = path.dirname(newJob.specPath);
    const newReportDir = path.dirname(newJob.reportPath);
    if (fs.existsSync(newUploadDir)) fs.rmSync(newUploadDir, { recursive: true, force: true });
    if (fs.existsSync(newReportDir)) fs.rmSync(newReportDir, { recursive: true, force: true });
  });
});
