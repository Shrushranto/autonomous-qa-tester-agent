const path = require('path');
const dotenv = require('dotenv');

// Load root .env first (for GEMINI_API_KEY, etc.), then local .env if present
const rootEnvPath = path.resolve(__dirname, '../../../../.env');
dotenv.config({ path: rootEnvPath });
const serverEnvPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: serverEnvPath });

const mongoose = require('mongoose');
const app = require('./app');

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/qa_tester_agent';

async function startServer() {
  try {
    console.log(`Connecting to MongoDB at: ${MONGODB_URI}`);
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    });
    console.log('✓ Successfully connected to MongoDB.');

    const server = app.listen(PORT, () => {
      console.log(`✓ Autonomous QA Tester Express Server running on port ${PORT}`);
      console.log(`✓ API Health: http://localhost:${PORT}/api/health`);
    });

    const shutdown = async (signal) => {
      console.log(`\nReceived ${signal}. Shutting down gracefully...`);
      server.close(async () => {
        try {
          await mongoose.connection.close();
          console.log('MongoDB connection closed.');
          process.exit(0);
        } catch (e) {
          process.exit(1);
        }
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    console.error('Fatal error during server startup:', error.message);
    process.exit(1);
  }
}

startServer();
