const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Job = require('../models/Job');
const mongoose = require('mongoose');

// Configuration
const PROJECT_ROOT = path.resolve(__dirname, '../../../../');
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10);
const EXECUTION_TIMEOUT_MS = parseInt(process.env.EXECUTION_TIMEOUT_MS || '300000', 10); // 5 mins

let activeJobCount = 0;
const runningProcesses = new Map(); // jobId -> ChildProcess

// Determine Python Executable
function getPythonExecutable() {
  if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
    return process.env.PYTHON_PATH;
  }

  const isWindows = process.platform === 'win32';
  const venvPythonWin = path.join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe');
  const venvPythonPosix = path.join(PROJECT_ROOT, '.venv', 'bin', 'python');

  if (isWindows && fs.existsSync(venvPythonWin)) {
    return venvPythonWin;
  }
  if (!isWindows && fs.existsSync(venvPythonPosix)) {
    return venvPythonPosix;
  }

  return isWindows ? 'python.exe' : 'python3';
}

// Sanitize log text to prevent leaking API keys or secrets
function sanitizeLogText(text) {
  if (!text) return '';
  return text
    .replace(/(?:AIzaSy|key=)[A-Za-z0-9_-]{20,}/gi, '[REDACTED_SECRET]')
    .replace(/(?:password|token|secret)[:=]\s*\S+/gi, '$1=[REDACTED]');
}

async function safeSave(doc) {
  try {
    if (mongoose.connection.readyState !== 1) return;
    if (doc) await doc.save();
  } catch (err) {
    if (err.name === 'DocumentNotFoundError' || err.name === 'VersionError') return;
    if (mongoose.connection.readyState !== 1) return;
    console.error('Error saving job state:', err);
  }
}

// Queue processor
async function processQueue() {
  if (mongoose.connection.readyState !== 1) {
    return;
  }
  if (activeJobCount >= MAX_CONCURRENT_JOBS) {
    return;
  }

  try {
    const nextJob = await Job.findOne({ status: 'queued' }).sort({ createdAt: 1 });
    if (!nextJob) {
      return;
    }

    activeJobCount++;
    runJob(nextJob.jobId).catch(err => {
      console.error(`Error initiating job ${nextJob.jobId}:`, err);
    });
  } catch (err) {
    console.error('Error in processQueue:', err);
  }
}

// Execute Python Agent child process
async function runJob(jobId) {
  if (mongoose.connection.readyState !== 1) {
    return;
  }
  const job = await Job.findOne({ jobId });
  if (!job) {
    activeJobCount = Math.max(0, activeJobCount - 1);
    return;
  }

  // Ensure report directory exists
  const reportDir = path.dirname(job.reportPath);
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  // Update status to running
  job.status = 'running';
  job.startedAt = new Date();
  job.statusMessage = 'Starting Autonomous QA Tester Agent...';
  job.logs.push({
    timestamp: new Date(),
    text: `Job initialized. Preparing Python testing engine...`,
    stream: 'system'
  });
  await safeSave(job);

  const pythonExec = getPythonExecutable();
  const args = [
    '-m', 'qa_agent',
    '--url', job.targetUrl,
    '--spec', job.specPath,
    '--report', job.reportPath,
    '--headless'
  ];

  if (job.answersPath && fs.existsSync(job.answersPath)) {
    args.push('--answers', job.answersPath);
  }

  job.logs.push({
    timestamp: new Date(),
    text: `Invoking: ${path.basename(pythonExec)} -m qa_agent --url ${job.targetUrl} --headless`,
    stream: 'system'
  });
  await safeSave(job);

  // Snapshot existing screenshot files in reports/ before run
  const reportsRootDir = path.join(PROJECT_ROOT, 'reports');
  const existingScreenshots = new Set(
    fs.existsSync(reportsRootDir)
      ? fs.readdirSync(reportsRootDir).filter(f => f.startsWith('bug_') && f.endsWith('.png'))
      : []
  );

  let child;
  try {
    child = spawn(pythonExec, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    runningProcesses.set(jobId, child);
  } catch (spawnErr) {
    activeJobCount = Math.max(0, activeJobCount - 1);
    job.status = 'failed';
    job.completedAt = new Date();
    job.errorMessage = `Failed to spawn Python process: ${spawnErr.message}`;
    job.statusMessage = 'Process spawn failure';
    await job.save();
    processQueue();
    return;
  }

  // Close stdin immediately so interactive prompt (clarification question) gracefully returns None
  if (child.stdin) {
    child.stdin.end();
  }

  let logBuffer = [];
  let saveTimer = null;

  const flushLogs = async () => {
    if (logBuffer.length === 0) return;
    if (mongoose.connection.readyState !== 1) return;
    try {
      const items = [...logBuffer];
      logBuffer = [];
      await Job.updateOne(
        { jobId },
        {
          $push: { logs: { $each: items } },
          statusMessage: items[items.length - 1].text.slice(0, 150)
        }
      );
    } catch (e) {
      if (mongoose.connection.readyState === 1) {
        console.error(`Error saving logs for ${jobId}:`, e);
      }
    }
  };

  const scheduleLogFlush = () => {
    if (!saveTimer) {
      saveTimer = setTimeout(async () => {
        saveTimer = null;
        await flushLogs();
      }, 500);
    }
  };

  const processLine = (rawLine, stream) => {
    const clean = sanitizeLogText(rawLine.trim());
    if (!clean) return;
    logBuffer.push({
      timestamp: new Date(),
      text: clean,
      stream
    });
    scheduleLogFlush();
  };

  // Stream stdout
  child.stdout.on('data', chunk => {
    const lines = chunk.toString().split(/\r?\n/);
    for (const l of lines) {
      processLine(l, 'stdout');
    }
  });

  // Stream stderr
  child.stderr.on('data', chunk => {
    const lines = chunk.toString().split(/\r?\n/);
    for (const l of lines) {
      processLine(l, 'stderr');
    }
  });

  // Setup execution timeout
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    processLine(`Execution timed out after ${EXECUTION_TIMEOUT_MS / 1000}s. Terminating child process.`, 'system');
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }, 3000);
    } catch (_) {}
  }, EXECUTION_TIMEOUT_MS);

  // Handle process completion
  child.on('close', async (code) => {
    clearTimeout(timeoutId);
    if (saveTimer) {
      clearTimeout(saveTimer);
      await flushLogs();
    }
    runningProcesses.delete(jobId);
    activeJobCount = Math.max(0, activeJobCount - 1);

    if (mongoose.connection.readyState !== 1) {
      return;
    }

    let updatedJob;
    try {
      updatedJob = await Job.findOne({ jobId });
    } catch (_) {
      return;
    }
    if (!updatedJob) {
      processQueue();
      return;
    }

    updatedJob.completedAt = new Date();
    updatedJob.exitCode = code;

    // Isolate any newly created screenshot evidence to this job's report directory
    try {
      if (fs.existsSync(reportsRootDir)) {
        const currentScreenshots = fs.readdirSync(reportsRootDir).filter(f => f.startsWith('bug_') && f.endsWith('.png'));
        const newScreenshots = currentScreenshots.filter(f => !existingScreenshots.has(f));
        // If there were screenshots produced or modified, copy them into the job's directory
        for (const shot of currentScreenshots) {
          const srcPath = path.join(reportsRootDir, shot);
          const destPath = path.join(reportDir, shot);
          if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      }
    } catch (e) {
      console.warn(`Could not copy evidence screenshots for ${jobId}:`, e);
    }

// Classify child process errors into structured error codes and messages
function classifyProcessError(code, timedOut, logs, statusJson) {
  if (timedOut) {
    return {
      code: 'EXECUTION_TIMEOUT',
      message: 'The test exceeded its allowed runtime and was stopped.',
      detail: `Child process exceeded maximum execution timeout of ${EXECUTION_TIMEOUT_MS / 1000}s.`,
      retryable: true
    };
  }

  // If status.json was written by the Python agent, use its structured classification
  if (statusJson && statusJson.error) {
    return {
      code: statusJson.error.code || 'AGENT_EXECUTION_FAILED',
      message: statusJson.error.message || 'The test agent stopped unexpectedly. No complete report was generated.',
      detail: statusJson.error.detail || null,
      retryable: statusJson.retryable !== false
    };
  }

  // Classify by Python agent exit code
  if (code === 10) {
    return {
      code: 'GEMINI_UNAVAILABLE',
      message: 'The AI model is temporarily overloaded. The agent retried the request but could not complete it. Please try again shortly.',
      detail: 'Exit code 10: Gemini service returned 503 Unavailable.',
      retryable: true
    };
  }
  if (code === 11) {
    return {
      code: 'GEMINI_RATE_LIMITED',
      message: 'The AI request limit has been reached. Please wait before starting another test.',
      detail: 'Exit code 11: Gemini rate limit / quota exceeded (429).',
      retryable: true
    };
  }
  if (code === 12) {
    return {
      code: 'GEMINI_AUTH_ERROR',
      message: 'The AI service configuration is invalid. Please contact the administrator.',
      detail: 'Exit code 12: Invalid API key or permission denied.',
      retryable: false
    };
  }
  if (code === 13) {
    return {
      code: 'GEMINI_TIMEOUT',
      message: 'The AI request timed out. Please try again.',
      detail: 'Exit code 13: Request deadline exceeded (504).',
      retryable: true
    };
  }

  // Scan recent logs for error signals
  const allLogText = (logs || []).map(l => l.text).join(' ').toLowerCase();

  if (allLogText.includes('503') || allLogText.includes('unavailable') || allLogText.includes('high demand') || allLogText.includes('overloaded')) {
    return {
      code: 'GEMINI_UNAVAILABLE',
      message: 'The AI model is temporarily overloaded. The agent retried the request but could not complete it. Please try again shortly.',
      detail: 'Log inspection matched 503 Unavailable.',
      retryable: true
    };
  }
  if (allLogText.includes('429') || allLogText.includes('resource_exhausted') || allLogText.includes('quota')) {
    return {
      code: 'GEMINI_RATE_LIMITED',
      message: 'The AI request limit has been reached. Please wait before starting another test.',
      detail: 'Log inspection matched 429 Rate Limit.',
      retryable: true
    };
  }
  if (allLogText.includes('api_key_invalid') || allLogText.includes('api key not valid') || allLogText.includes('unauthenticated')) {
    return {
      code: 'GEMINI_AUTH_ERROR',
      message: 'The AI service configuration is invalid. Please contact the administrator.',
      detail: 'Log inspection matched invalid API key.',
      retryable: false
    };
  }
  if (allLogText.includes('504') || allLogText.includes('deadline_exceeded') || allLogText.includes('timeout')) {
    return {
      code: 'GEMINI_TIMEOUT',
      message: 'The AI request timed out. Please try again.',
      detail: 'Log inspection matched timeout error.',
      retryable: true
    };
  }

  return {
    code: 'AGENT_EXECUTION_FAILED',
    message: 'The test agent stopped unexpectedly. No complete report was generated.',
    detail: `Process failed with exit code ${code}. Check agent logs.`,
    retryable: true
  };
}

    // Check if Python agent wrote status.json in reportDir
    const statusFile = path.join(reportDir, 'status.json');
    let statusJson = null;
    if (fs.existsSync(statusFile)) {
      try {
        statusJson = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      } catch (_) {}
    }

    const reportExists = fs.existsSync(updatedJob.reportPath) && fs.statSync(updatedJob.reportPath).size > 0;

    if (reportExists && !timedOut && (code === 0 || (statusJson && statusJson.status === 'completed'))) {
      updatedJob.status = 'completed';
      updatedJob.reportAvailable = true;
      updatedJob.statusMessage = 'Test run completed successfully. Report generated.';
      updatedJob.error = null;
      updatedJob.errorMessage = null;
      updatedJob.retryable = false;
    } else if (code === 0 && !reportExists) {
      updatedJob.status = 'failed';
      updatedJob.reportAvailable = false;
      updatedJob.statusMessage = 'Testing stopped, but the report could not be generated.';
      updatedJob.error = {
        code: 'REPORT_NOT_GENERATED',
        message: 'Testing stopped, but the report could not be generated. Please check the run details before retrying.',
        detail: 'Process exited with code 0 but no report file was generated.'
      };
      updatedJob.errorMessage = updatedJob.error.message;
      updatedJob.retryable = true;
    } else {
      const classified = classifyProcessError(code, timedOut, updatedJob.logs, statusJson);
      updatedJob.status = 'failed';
      updatedJob.reportAvailable = false;
      updatedJob.error = {
        code: classified.code,
        message: classified.message,
        detail: classified.detail
      };
      updatedJob.errorMessage = classified.message;
      updatedJob.statusMessage = classified.message;
      updatedJob.retryable = classified.retryable;
    }

    await safeSave(updatedJob);
    processQueue();
  });

  child.on('error', async (err) => {
    clearTimeout(timeoutId);
    runningProcesses.delete(jobId);
    activeJobCount = Math.max(0, activeJobCount - 1);

    const updatedJob = await Job.findOne({ jobId });
    if (updatedJob) {
      updatedJob.status = 'failed';
      updatedJob.completedAt = new Date();
      updatedJob.errorMessage = `Child process error: ${err.message}`;
      updatedJob.statusMessage = 'Execution failed';
      await safeSave(updatedJob);
    }
    processQueue();
  });
}

// Cancel a running or queued job
async function cancelJob(jobId) {
  const child = runningProcesses.get(jobId);
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch (_) {}
    runningProcesses.delete(jobId);
    activeJobCount = Math.max(0, activeJobCount - 1);
  }

  const job = await Job.findOne({ jobId });
  if (job && (job.status === 'queued' || job.status === 'running')) {
    job.status = 'failed';
    job.completedAt = new Date();
    job.statusMessage = 'Job cancelled by user';
    job.errorMessage = 'Job was cancelled.';
    await safeSave(job);
  }

  processQueue();
}

module.exports = {
  processQueue,
  runJob,
  cancelJob,
  getPythonExecutable,
  sanitizeLogText
};
