const mongoose = require('mongoose');

const logEntrySchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  text: { type: String, required: true },
  stream: { type: String, enum: ['stdout', 'stderr', 'system'], default: 'stdout' }
}, { _id: false });

const jobSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  targetUrl: {
    type: String,
    required: true
  },
  specFilename: {
    type: String,
    required: true
  },
  answersFilename: {
    type: String,
    default: null
  },
  specPath: {
    type: String,
    required: true
  },
  answersPath: {
    type: String,
    default: null
  },
  reportPath: {
    type: String,
    required: true
  },
  evidenceDir: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['queued', 'running', 'completed', 'failed'],
    default: 'queued',
    index: true
  },
  statusMessage: {
    type: String,
    default: 'Job queued and awaiting execution'
  },
  reportAvailable: {
    type: Boolean,
    default: false
  },
  errorMessage: {
    type: String,
    default: null
  },
  error: {
    code: { type: String, default: null },
    message: { type: String, default: null },
    detail: { type: String, default: null }
  },
  retryable: {
    type: Boolean,
    default: true
  },
  exitCode: {
    type: Number,
    default: null
  },
  logs: [logEntrySchema],
  createdAt: {
    type: Date,
    default: Date.now
  },
  startedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.model('Job', jobSchema);
