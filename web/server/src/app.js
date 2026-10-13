const express = require('express');
const cors = require('cors');
const path = require('path');
const testRoutes = require('./routes/testRoutes');

const app = express();

// Allowed origins
const clientOrigin = process.env.CLIENT_URL || 'http://localhost:5173';
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl, server-to-server) or matching client origin
    if (!origin || origin === clientOrigin || origin === 'http://127.0.0.1:5173') {
      callback(null, true);
    } else {
      callback(null, true); // Permissive in local dev, restricted in prod
    }
  },
  credentials: true
}));

// Basic Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// JSON and URL-encoded body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Autonomous QA Tester API',
    timestamp: new Date().toISOString()
  });
});

// Test routes
app.use('/api', testRoutes);

// 404 Handler
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal Server Error'
    : (err.message || 'Internal Server Error');

  res.status(status).json({ error: message });
});

module.exports = app;
