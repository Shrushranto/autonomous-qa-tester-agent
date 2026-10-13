const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Job = require('../models/Job');
const { validateTargetUrl, uploadMiddleware } = require('../middleware/validate');
const { processQueue, cancelJob } = require('../services/pythonAgent');

const router = express.Router();
const PROJECT_ROOT = path.resolve(__dirname, '../../../../');
const ALLOW_LOCAL_TARGETS = process.env.ALLOW_LOCAL_TARGETS === 'true' || process.env.NODE_ENV !== 'production';

function isSafePath(baseDir, targetPath) {
  const resolved = path.resolve(baseDir, targetPath).toLowerCase();
  const base = path.resolve(baseDir).toLowerCase();
  return resolved.startsWith(base);
}

/**
 * GET /api/demo-report
 * Retrieve pre-generated demo bug report
 */
router.get('/demo-report', async (req, res) => {
  try {
    const demoJobId = 'demo-sample-report';
    const candidateFiles = [
      path.join(PROJECT_ROOT, 'reports', 'demo_all_bugs_1.md'),
      path.join(PROJECT_ROOT, 'reports', 'demo_all_bugs.md'),
      path.join(PROJECT_ROOT, 'reports', 'bug_report.md')
    ];

    let reportMarkdown = null;
    let chosenPath = null;
    for (const cand of candidateFiles) {
      if (fs.existsSync(cand)) {
        reportMarkdown = fs.readFileSync(cand, 'utf8');
        chosenPath = cand;
        break;
      }
    }

    if (!reportMarkdown) {
      return res.status(404).json({ error: 'Demo report not found.' });
    }

    // Ensure demo job exists in MongoDB so download & evidence routes work
    const demoJobDir = path.join(PROJECT_ROOT, 'reports', 'jobs', demoJobId);
    if (!fs.existsSync(demoJobDir)) {
      fs.mkdirSync(demoJobDir, { recursive: true });
    }
    const destReportPath = path.join(demoJobDir, 'report.md');
    fs.copyFileSync(chosenPath, destReportPath);

    // Copy any screenshots from reports/ into demoJobDir
    const rootReportsDir = path.join(PROJECT_ROOT, 'reports');
    if (fs.existsSync(rootReportsDir)) {
      const shots = fs.readdirSync(rootReportsDir).filter(f => f.startsWith('bug_') && f.endsWith('.png'));
      for (const s of shots) {
        fs.copyFileSync(path.join(rootReportsDir, s), path.join(demoJobDir, s));
      }
    }

    await Job.findOneAndUpdate(
      { jobId: demoJobId },
      {
        jobId: demoJobId,
        targetUrl: 'http://localhost:3000',
        specFilename: 'shop.md',
        specPath: path.join(PROJECT_ROOT, 'specs', 'shop.md'),
        reportPath: destReportPath,
        evidenceDir: demoJobDir,
        status: 'completed',
        statusMessage: 'Completed sample demo report (Plant: none, 4 Confirmed Bugs)',
        reportAvailable: true,
        completedAt: new Date('2026-10-12T21:39:49Z')
      },
      { upsert: true, new: true }
    );

    return res.json({
      jobId: demoJobId,
      targetUrl: 'http://localhost:3000',
      specFilename: 'shop.md',
      completedAt: '2026-10-12T21:39:49Z',
      reportMarkdown
    });
  } catch (err) {
    console.error('Error fetching demo report:', err);
    return res.status(500).json({ error: 'Failed to retrieve demo report.' });
  }
});

/**
 * POST /api/tests
 * Start a new test job
 */
router.post('/tests', (req, res, next) => {
  uploadMiddleware(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { url } = req.body;

    // Validate Target URL
    const urlCheck = validateTargetUrl(url, ALLOW_LOCAL_TARGETS);
    if (!urlCheck.valid) {
      // Clean up uploaded files if invalid URL
      if (req.files?.spec?.[0]?.path) fs.rmSync(path.dirname(req.files.spec[0].path), { recursive: true, force: true });
      return res.status(400).json({ error: urlCheck.error });
    }

    // Validate Spec File
    if (!req.files || !req.files.spec || req.files.spec.length === 0) {
      return res.status(400).json({ error: 'A specification Markdown (.md) file is required.' });
    }

    const specFile = req.files.spec[0];
    const specOriginalName = path.basename(specFile.originalname);
    const specPath = specFile.path;

    // Optional Answers File
    let answersOriginalName = null;
    let answersPath = null;
    if (req.files.answers && req.files.answers.length > 0) {
      const answersFile = req.files.answers[0];
      answersOriginalName = path.basename(answersFile.originalname);
      answersPath = answersFile.path;
    }

    const jobId = req.jobId || uuidv4();

    // Isolated report path per job
    const jobReportDir = path.join(PROJECT_ROOT, 'reports', 'jobs', jobId);
    const reportPath = path.join(jobReportDir, 'report.md');

    // Create MongoDB Record
    const job = new Job({
      jobId,
      targetUrl: urlCheck.url,
      specFilename: specOriginalName,
      answersFilename: answersOriginalName,
      specPath,
      answersPath,
      reportPath,
      evidenceDir: jobReportDir,
      status: 'queued',
      statusMessage: 'Job queued and awaiting execution slot',
      reportAvailable: false,
      logs: [
        {
          timestamp: new Date(),
          text: `Test job created for ${urlCheck.url} with specification: ${specOriginalName}`,
          stream: 'system'
        }
      ]
    });

    await job.save();

    // Trigger execution queue
    processQueue();

    return res.status(201).json({
      jobId,
      status: job.status,
      message: 'Test job submitted successfully'
    });
  } catch (error) {
    console.error('Error submitting test job:', error);
    return res.status(500).json({ error: 'An unexpected error occurred while creating the test job.' });
  }
});

/**
 * GET /api/tests
 * List recent test jobs
 */
router.get('/tests', async (req, res) => {
  try {
    const jobs = await Job.find({})
      .sort({ createdAt: -1 })
      .limit(30)
      .select('jobId targetUrl specFilename status statusMessage reportAvailable createdAt startedAt completedAt errorMessage exitCode');
    return res.json({ jobs });
  } catch (error) {
    console.error('Error listing jobs:', error);
    return res.status(500).json({ error: 'Failed to retrieve jobs.' });
  }
});

/**
 * GET /api/tests/:id
 * Retrieve job status and details
 */
router.get('/tests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const job = await Job.findOne({ jobId: id });
    if (!job) {
      return res.status(404).json({ error: 'Test job not found.' });
    }

    return res.json({
      jobId: job.jobId,
      targetUrl: job.targetUrl,
      specFilename: job.specFilename,
      answersFilename: job.answersFilename,
      status: job.status,
      statusMessage: job.statusMessage,
      reportAvailable: job.reportAvailable,
      errorMessage: job.errorMessage,
      error: job.error,
      retryable: job.retryable,
      exitCode: job.exitCode,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      logs: job.logs.slice(-150) // Return recent logs
    });
  } catch (error) {
    console.error(`Error retrieving job ${req.params.id}:`, error);
    return res.status(500).json({ error: 'Failed to retrieve job details.' });
  }
});

/**
 * POST /api/tests/:id/retry
 * Create a new test job retrying a failed test run without overwriting previous results
 */
router.post('/tests/:id/retry', async (req, res) => {
  try {
    const { id } = req.params;
    const oldJob = await Job.findOne({ jobId: id });
    if (!oldJob) {
      return res.status(404).json({ error: 'Original test job not found.' });
    }

    if (oldJob.status !== 'failed' && oldJob.status !== 'completed') {
      return res.status(400).json({ error: 'Cannot retry a job that is currently active.' });
    }

    if (oldJob.retryable === false) {
      return res.status(400).json({
        error: 'This job encountered a non-retryable error (such as an invalid API key). Please fix the configuration before running a new test.'
      });
    }

    const newJobId = uuidv4();
    const uploadsBaseDir = path.resolve(__dirname, '../../uploads');
    const newUploadDir = path.join(uploadsBaseDir, newJobId);
    fs.mkdirSync(newUploadDir, { recursive: true });

    // Copy original specification file to new isolated directory
    const newSpecPath = path.join(newUploadDir, 'spec.md');
    if (fs.existsSync(oldJob.specPath)) {
      fs.copyFileSync(oldJob.specPath, newSpecPath);
    } else {
      return res.status(400).json({ error: 'Original specification file is no longer available on server.' });
    }

    // Copy answers file if present
    let newAnswersPath = null;
    if (oldJob.answersPath && fs.existsSync(oldJob.answersPath)) {
      newAnswersPath = path.join(newUploadDir, 'answers.json');
      fs.copyFileSync(oldJob.answersPath, newAnswersPath);
    }

    // Isolated report path for the new retry job
    const newJobReportDir = path.join(PROJECT_ROOT, 'reports', 'jobs', newJobId);
    const newReportPath = path.join(newJobReportDir, 'report.md');

    const newJob = new Job({
      jobId: newJobId,
      targetUrl: oldJob.targetUrl,
      specFilename: oldJob.specFilename,
      answersFilename: oldJob.answersFilename,
      specPath: newSpecPath,
      answersPath: newAnswersPath,
      reportPath: newReportPath,
      evidenceDir: newJobReportDir,
      status: 'queued',
      statusMessage: `Retry of job ${oldJob.jobId.slice(0, 8)} queued`,
      reportAvailable: false,
      logs: [
        {
          timestamp: new Date(),
          text: `Retry test job created for ${oldJob.targetUrl} (retrying ${oldJob.jobId})`,
          stream: 'system'
        }
      ]
    });

    await newJob.save();
    processQueue();

    return res.status(201).json({
      jobId: newJobId,
      status: newJob.status,
      message: 'Retry test job created successfully'
    });
  } catch (error) {
    console.error(`Error retrying job ${req.params.id}:`, error);
    return res.status(500).json({ error: 'Failed to initiate retry.' });
  }
});

/**
 * GET /api/tests/:id/report
 * Retrieve rendered or raw Markdown report content
 */
router.get('/tests/:id/report', async (req, res) => {
  try {
    const { id } = req.params;
    const job = await Job.findOne({ jobId: id });
    if (!job) {
      return res.status(404).json({ error: 'Test job not found.' });
    }

    if (!job.reportAvailable || !fs.existsSync(job.reportPath)) {
      return res.status(404).json({
        error: 'Report is not available yet or the test run did not generate a report.'
      });
    }

    // Verify report is within safe bounds
    if (!isSafePath(PROJECT_ROOT, job.reportPath)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const reportMarkdown = fs.readFileSync(job.reportPath, 'utf8');

    return res.json({
      jobId: job.jobId,
      targetUrl: job.targetUrl,
      specFilename: job.specFilename,
      completedAt: job.completedAt,
      reportMarkdown
    });
  } catch (error) {
    console.error(`Error reading report for ${req.params.id}:`, error);
    return res.status(500).json({ error: 'Failed to read test report.' });
  }
});

/**
 * GET /api/tests/:id/download
 * Download raw Markdown report
 */
router.get('/tests/:id/download', async (req, res) => {
  try {
    const { id } = req.params;
    const job = await Job.findOne({ jobId: id });
    if (!job) {
      return res.status(404).json({ error: 'Test job not found.' });
    }

    if (!job.reportAvailable || !fs.existsSync(job.reportPath)) {
      return res.status(404).json({ error: 'Report is not available for download.' });
    }

    if (!isSafePath(PROJECT_ROOT, job.reportPath)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="qa_report_${id.slice(0, 8)}.md"`);
    return res.sendFile(path.resolve(job.reportPath));
  } catch (error) {
    console.error(`Error downloading report for ${req.params.id}:`, error);
    return res.status(500).json({ error: 'Failed to download report.' });
  }
});

/**
 * GET /api/tests/:id/evidence/:filename
 * Safely serve screenshot evidence for this job
 */
router.get('/tests/:id/evidence/:filename', async (req, res) => {
  try {
    const { id, filename } = req.params;
    // Strict filename validation
    if (!/^[a-zA-Z0-9_\-\.]+\.(png|jpg|jpeg|webp)$/i.test(filename)) {
      return res.status(400).json({ error: 'Invalid evidence filename.' });
    }

    const job = await Job.findOne({ jobId: id });
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    // Try job evidence directory first, then root reports directory
    const candidates = [
      path.join(PROJECT_ROOT, 'reports', 'jobs', id, filename),
      path.join(PROJECT_ROOT, 'reports', filename)
    ];

    let foundPath = null;
    for (const cand of candidates) {
      if (fs.existsSync(cand) && isSafePath(PROJECT_ROOT, cand)) {
        foundPath = cand;
        break;
      }
    }

    if (!foundPath) {
      return res.status(404).json({ error: 'Evidence file not found.' });
    }

    res.setHeader('Content-Type', 'image/png');
    return res.sendFile(path.resolve(foundPath));
  } catch (error) {
    console.error('Error serving evidence:', error);
    return res.status(500).json({ error: 'Failed to serve evidence.' });
  }
});

/**
 * POST /api/tests/:id/cancel
 * Cancel a test job
 */
router.post('/tests/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    await cancelJob(id);
    return res.json({ message: 'Cancellation requested.' });
  } catch (error) {
    console.error(`Error cancelling job ${req.params.id}:`, error);
    return res.status(500).json({ error: 'Failed to cancel job.' });
  }
});

module.exports = router;
