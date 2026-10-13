const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// Check if an IP address belongs to private/internal ranges
function isPrivateOrReservedIP(ip) {
  // Normalize IPv6-mapped IPv4
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  // IPv6 loopback and private
  if (ip === '::1' || ip === 'fe80::' || ip.startsWith('fc') || ip.startsWith('fd')) {
    return true;
  }

  // IPv4 regex checks
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }

  const [a, b, c, d] = parts;

  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;

  // 10.0.0.0/8 (Private)
  if (a === 10) return true;

  // 172.16.0.0/12 (Private: 172.16.0.0 – 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 (Private)
  if (a === 192 && b === 168) return true;

  // 169.254.0.0/16 (Link-Local, includes AWS metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;

  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
  if (a >= 224) return true;

  return false;
}

// Validate Target URL
function validateTargetUrl(rawUrl, allowLocalTargets = false) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'A target website URL is required.' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (e) {
    return { valid: false, error: 'Invalid URL format. Please provide a valid HTTP or HTTPS URL.' };
  }

  // Enforce HTTP / HTTPS protocol only
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `Protocol "${parsed.protocol}" is not supported. Use http:// or https://.` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Handle localhost / loopback
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local');
  if (isLoopback) {
    if (allowLocalTargets) {
      return { valid: true, url: parsed.toString() };
    }
    return {
      valid: false,
      error: 'Requests to localhost / loopback addresses are restricted in this environment.'
    };
  }

  // Cloud metadata hosts and internal names
  const forbiddenHostnames = [
    'metadata.google.internal',
    '169.254.169.254',
    'instance-data',
    'metadata'
  ];
  if (forbiddenHostnames.includes(hostname)) {
    return { valid: false, error: 'Access to cloud metadata services is strictly forbidden.' };
  }

  // Check if hostname is an IP literal
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Regex.test(hostname)) {
    if (isPrivateOrReservedIP(hostname)) {
      if (allowLocalTargets && (hostname.startsWith('127.') || hostname === '192.168.' || hostname === '10.')) {
        return { valid: true, url: parsed.toString() };
      }
      return { valid: false, error: 'Access to private and internal network IP addresses is restricted.' };
    }
  }

  return { valid: true, url: parsed.toString() };
}

// Configure Multer storage
const uploadsBaseDir = path.resolve(__dirname, '../../uploads');
if (!fs.existsSync(uploadsBaseDir)) {
  fs.mkdirSync(uploadsBaseDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Generate or retrieve jobId for this request
    if (!req.jobId) {
      req.jobId = uuidv4();
    }
    const jobUploadDir = path.join(uploadsBaseDir, req.jobId);
    if (!fs.existsSync(jobUploadDir)) {
      fs.mkdirSync(jobUploadDir, { recursive: true });
    }
    cb(null, jobUploadDir);
  },
  filename: (req, file, cb) => {
    // Sanitize and assign server-controlled filename
    if (file.fieldname === 'spec') {
      cb(null, 'spec.md');
    } else if (file.fieldname === 'answers') {
      cb(null, 'answers.json');
    } else {
      cb(new Error(`Unexpected fieldname: ${file.fieldname}`));
    }
  }
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.fieldname === 'spec') {
    if (ext === '.md' || ext === '.markdown') {
      return cb(null, true);
    }
    return cb(new Error('Specification file must be a Markdown (.md) file.'));
  }

  if (file.fieldname === 'answers') {
    if (ext === '.json') {
      return cb(null, true);
    }
    return cb(new Error('Answers file must be a JSON (.json) file.'));
  }

  cb(new Error(`Unexpected field: ${file.fieldname}`));
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB max for spec
    files: 2
  }
});

module.exports = {
  validateTargetUrl,
  isPrivateOrReservedIP,
  uploadMiddleware: upload.fields([
    { name: 'spec', maxCount: 1 },
    { name: 'answers', maxCount: 1 }
  ])
};
