const request = require('supertest');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

// Mock child_process so tests don't run heavy Python agent
jest.mock('child_process', () => {
  const EventEmitter = require('events');
  return {
    spawn: jest.fn(() => {
      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      mockChild.stdin = { end: jest.fn() };
      mockChild.kill = jest.fn();

      // Emit some stdout and close cleanly on next tick
      process.nextTick(() => {
        mockChild.stdout.emit('data', Buffer.from('Generating test plan with Gemini...\n'));
        mockChild.stdout.emit('data', Buffer.from('Executing test TEST-1...\n'));
        mockChild.emit('close', 0);
      });

      return mockChild;
    })
  };
});

const app = require('../src/app');
const Job = require('../src/models/Job');

const TEST_DB = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/qa_tester_test';

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
});

afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 50));
  await Job.deleteMany({});
  await mongoose.connection.close();
});

beforeEach(async () => {
  await Job.deleteMany({});
});

describe('API Endpoints /api/tests', () => {
  test('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST /api/tests rejects missing URL', async () => {
    const res = await request(app)
      .post('/api/tests')
      .attach('spec', Buffer.from('# Specs'), 'spec.md');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/target website URL is required/i);
  });

  test('POST /api/tests rejects missing spec file', async () => {
    const res = await request(app)
      .post('/api/tests')
      .field('url', 'http://localhost:3000');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/specification.*required/i);
  });

  test('POST /api/tests rejects non-markdown file extension', async () => {
    const res = await request(app)
      .post('/api/tests')
      .field('url', 'http://localhost:3000')
      .attach('spec', Buffer.from('console.log("hello")'), 'test.js');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be a Markdown/i);
  });

  test('POST /api/tests succeeds with valid URL and markdown spec', async () => {
    const specContent = '# Demo Shop Specification\n## Rule 1: Cart Calculation';
    const res = await request(app)
      .post('/api/tests')
      .field('url', 'http://localhost:3000')
      .attach('spec', Buffer.from(specContent), 'shop.md');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('jobId');
    expect(res.body.status).toBe('queued');

    // Verify record in MongoDB
    const job = await Job.findOne({ jobId: res.body.jobId });
    expect(job).not.toBeNull();
    expect(job.targetUrl).toBe('http://localhost:3000/');
    expect(job.specFilename).toBe('shop.md');
  });

  test('GET /api/tests/:id returns 404 for unknown job', async () => {
    const res = await request(app).get('/api/tests/non-existent-uuid');
    expect(res.status).toBe(404);
  });

  test('GET /api/tests/:id returns job status', async () => {
    const job = await Job.create({
      jobId: 'test-job-123',
      targetUrl: 'http://localhost:3000',
      specFilename: 'test.md',
      specPath: 'dummy/path',
      reportPath: 'dummy/report.md',
      status: 'queued',
      statusMessage: 'Queued test'
    });

    const res = await request(app).get(`/api/tests/${job.jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe('test-job-123');
    expect(res.body.status).toBe('queued');
  });

  test('GET /api/tests/:id/report returns 404 when report not available', async () => {
    const job = await Job.create({
      jobId: 'test-job-no-report',
      targetUrl: 'http://localhost:3000',
      specFilename: 'test.md',
      specPath: 'dummy/path',
      reportPath: 'dummy/report.md',
      status: 'running',
      reportAvailable: false
    });

    const res = await request(app).get(`/api/tests/${job.jobId}/report`);
    expect(res.status).toBe(404);
  });

  test('GET /api/tests/:id/report returns markdown when available', async () => {
    const tempReportDir = path.resolve(__dirname, '../../../reports/jobs/test-job-avail');
    fs.mkdirSync(tempReportDir, { recursive: true });
    const tempReportFile = path.join(tempReportDir, 'report.md');
    fs.writeFileSync(tempReportFile, '# Test Report\n\nAll tests passed.');

    const job = await Job.create({
      jobId: 'test-job-avail',
      targetUrl: 'http://localhost:3000',
      specFilename: 'test.md',
      specPath: 'dummy/path',
      reportPath: tempReportFile,
      status: 'completed',
      reportAvailable: true
    });

    const res = await request(app).get(`/api/tests/${job.jobId}/report`);
    expect(res.status).toBe(200);
    expect(res.body.reportMarkdown).toContain('# Test Report');

    // Clean up
    fs.rmSync(tempReportDir, { recursive: true, force: true });
  });

  test('GET /api/tests/:id/download serves file as markdown attachment', async () => {
    const tempReportDir = path.resolve(__dirname, '../../../reports/jobs/test-job-dl');
    fs.mkdirSync(tempReportDir, { recursive: true });
    const tempReportFile = path.join(tempReportDir, 'report.md');
    fs.writeFileSync(tempReportFile, '# Downloadable Report');

    const job = await Job.create({
      jobId: 'test-job-dl',
      targetUrl: 'http://localhost:3000',
      specFilename: 'test.md',
      specPath: 'dummy/path',
      reportPath: tempReportFile,
      status: 'completed',
      reportAvailable: true
    });

    const res = await request(app).get(`/api/tests/${job.jobId}/download`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text).toBe('# Downloadable Report');

    // Clean up
    fs.rmSync(tempReportDir, { recursive: true, force: true });
  });
});
