import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';
import QRCode from 'qrcode';
import { ZipArchive } from 'archiver';

// Setup directories
const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOADS_DIR = path.resolve(DATA_DIR, 'uploads');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Interfaces
export interface StoredFile {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  uploaderId: string;
  uploaderDevice: string;
  hash?: string;
  isVcard: boolean;
}

export interface ClientSession {
  sessionId: string;
  clientIp: string;
  userAgent: string;
  deviceLabel: string;
  createdAt: number;
  expiresAt: number;
  lastActiveAt: number;
}

export interface PairingInvitation {
  secret: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuditLogItem {
  id: string;
  timestamp: string;
  type: 'PAIR' | 'UPLOAD' | 'DOWNLOAD' | 'DELETE' | 'REVOKE' | 'CONFIG' | 'ALERT';
  message: string;
  clientIp?: string;
  device?: string;
}

// Server in-memory state
let isSharingActive = true;
let maxFileSize = 100 * 1024 * 1024; // 100 MiB
let maxTotalStorage = 1024 * 1024 * 1024; // 1 GiB
let pairingLifespanMs = 5 * 60 * 1000; // 5 minutes
let sessionLifespanMs = 30 * 60 * 1000; // 30 minutes

let activeInvitation: PairingInvitation = {
  secret: generatePairingSecret(),
  createdAt: Date.now(),
  expiresAt: Date.now() + pairingLifespanMs,
};

const activeSessions = new Map<string, ClientSession>();
const failedPairingAttempts = new Map<string, { count: number; lockedUntil: number }>();
const auditLogs: AuditLogItem[] = [];

// Stored files metadata
const filesDbFile = path.resolve(DATA_DIR, 'files_meta.json');
let storedFiles: StoredFile[] = [];

function loadFilesMetadata() {
  try {
    if (fs.existsSync(filesDbFile)) {
      const data = fs.readFileSync(filesDbFile, 'utf-8');
      storedFiles = JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading files metadata:', err);
    storedFiles = [];
  }
}

function saveFilesMetadata() {
  try {
    fs.writeFileSync(filesDbFile, JSON.stringify(storedFiles, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving files metadata:', err);
  }
}

loadFilesMetadata();

function generatePairingSecret(): string {
  // 6 uppercase alphanumeric characters, excluding confusing characters (0/O, 1/I)
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let result = '';
  const randomBytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

function getCandidateIps(): { name: string; ip: string; isDefault: boolean }[] {
  const interfaces = os.networkInterfaces();
  const candidates: { name: string; ip: string; isDefault: boolean }[] = [];

  for (const [name, netList] of Object.entries(interfaces)) {
    if (!netList) continue;
    for (const net of netList) {
      if (net.family === 'IPv4' && !net.internal) {
        const isCommon =
          net.address.startsWith('192.168.') ||
          net.address.startsWith('10.') ||
          net.address.startsWith('172.');
        candidates.push({
          name: `${name} (${net.address})`,
          ip: net.address,
          isDefault: isCommon,
        });
      }
    }
  }

  // Fallback to loopback if no external LAN interface found
  if (candidates.length === 0) {
    candidates.push({
      name: 'Loopback Localhost',
      ip: '127.0.0.1',
      isDefault: true,
    });
  }

  return candidates;
}

let configuredAdvertiseIp: string = getCandidateIps()[0]?.ip || '127.0.0.1';

function logAudit(
  type: AuditLogItem['type'],
  message: string,
  clientIp?: string,
  device?: string
) {
  const item: AuditLogItem = {
    id: crypto.randomUUID(),
    timestamp: new Date().toLocaleTimeString(),
    type,
    message,
    clientIp,
    device,
  };
  auditLogs.unshift(item);
  if (auditLogs.length > 100) auditLogs.pop();
}

logAudit('ALERT', 'LocalDrop server initialized on host');

// Parse user-agent helper for clean display in UI
function parseDevice(userAgent: string = ''): string {
  const ua = userAgent.toLowerCase();
  if (ua.includes('iphone')) return 'iPhone (Safari)';
  if (ua.includes('ipad')) return 'iPad (Safari)';
  if (ua.includes('android')) return 'Android Phone';
  if (ua.includes('macintosh') || ua.includes('mac os')) return 'MacBook / Mac';
  if (ua.includes('windows')) return 'Windows PC';
  if (ua.includes('linux')) return 'Linux PC';
  return 'Mobile / Browser Device';
}

// Compute total storage consumed
function getTotalStorageConsumed(): number {
  return storedFiles.reduce((acc, f) => acc + (f.size || 0), 0);
}

// Express App
const app = express();
app.use(express.json());
app.use(cookieParser());

// Multer configured with bounded temp files
const storageEngine = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    // Generate isolated random ID with .tmp prefix
    const safeTempName = `tmp_${crypto.randomUUID()}`;
    cb(null, safeTempName);
  },
});

const upload = multer({
  storage: storageEngine,
  limits: {
    fileSize: maxFileSize,
  },
});

// Middleware: Authenticate client session
function requireClientSession(req: Request, res: Response, next: NextFunction) {
  if (!isSharingActive) {
    return res.status(503).json({
      error: 'SHARING_HALTED',
      message: 'LocalDrop sharing has been stopped by the PC host.',
    });
  }

  const cookieToken = req.cookies?.localdrop_session;
  const headerToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const token = cookieToken || headerToken;

  if (!token) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'A valid paired session is required to access files.',
    });
  }

  const session = activeSessions.get(token);
  if (!session) {
    return res.status(401).json({
      error: 'SESSION_INVALID',
      message: 'Session not found or has been revoked.',
    });
  }

  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return res.status(401).json({
      error: 'SESSION_EXPIRED',
      message: 'Your pairing session has expired. Please re-pair with the host.',
    });
  }

  // Update activity timestamp
  session.lastActiveAt = Date.now();
  (req as any).clientSession = session;
  next();
}

// ======================== API ROUTES ========================

// Health check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'LocalDrop',
    sharingActive: isSharingActive,
    time: new Date().toISOString(),
  });
});

// Host Admin Status & Controls
app.get('/api/admin/status', (req: Request, res: Response) => {
  const now = Date.now();
  const invitationRemaining = Math.max(0, Math.floor((activeInvitation.expiresAt - now) / 1000));
  const candidateIps = getCandidateIps();

  res.json({
    isSharingActive,
    maxFileSize,
    maxTotalStorage,
    totalStorageUsed: getTotalStorageConsumed(),
    pairingSecret: activeInvitation.secret,
    pairingExpiresInSeconds: invitationRemaining,
    advertiseIp: configuredAdvertiseIp,
    candidateIps,
    activeSessions: Array.from(activeSessions.values()).map((s) => ({
      sessionId: s.sessionId,
      clientIp: s.clientIp,
      deviceLabel: s.deviceLabel,
      userAgent: s.userAgent,
      connectedAgo: Math.floor((now - s.createdAt) / 1000),
      expiresIn: Math.max(0, Math.floor((s.expiresAt - now) / 1000)),
    })),
    auditLogs: auditLogs.slice(0, 30),
    fileCount: storedFiles.length,
  });
});

// Toggle Sharing
app.post('/api/admin/toggle-sharing', (req: Request, res: Response) => {
  const { active } = req.body;
  isSharingActive = active !== undefined ? Boolean(active) : !isSharingActive;
  logAudit(
    'ALERT',
    isSharingActive ? 'Sharing resumed by host' : 'Sharing stopped by host'
  );
  res.json({ success: true, isSharingActive });
});

// Regenerate Pairing Code
app.post('/api/admin/regenerate-invite', (req: Request, res: Response) => {
  activeInvitation = {
    secret: generatePairingSecret(),
    createdAt: Date.now(),
    expiresAt: Date.now() + pairingLifespanMs,
  };
  logAudit('PAIR', `New pairing code generated: ${activeInvitation.secret}`);
  res.json({
    success: true,
    secret: activeInvitation.secret,
    expiresInSeconds: Math.floor(pairingLifespanMs / 1000),
  });
});

// Configure Advertise IP
app.post('/api/admin/configure-network', (req: Request, res: Response) => {
  const { ip } = req.body;
  if (ip && typeof ip === 'string') {
    configuredAdvertiseIp = ip.trim();
    logAudit('CONFIG', `Advertise IP set to ${configuredAdvertiseIp}`);
  }
  res.json({ success: true, advertiseIp: configuredAdvertiseIp });
});

// Revoke a specific session
app.post('/api/admin/revoke-session', (req: Request, res: Response) => {
  const { sessionId } = req.body;
  if (sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    activeSessions.delete(sessionId);
    logAudit('REVOKE', `Session revoked for ${session?.deviceLabel || sessionId}`);
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Session not found' });
});

// Revoke all client sessions
app.post('/api/admin/revoke-all', (req: Request, res: Response) => {
  const count = activeSessions.size;
  activeSessions.clear();
  logAudit('REVOKE', `Revoked all active sessions (${count} total)`);
  res.json({ success: true, revokedCount: count });
});

// Generate QR Code data URL
app.get('/api/admin/pairing-qr', async (req: Request, res: Response) => {
  const port = process.env.PORT || 3000;
  const protocol = req.protocol || 'http';
  // Use advertise IP or the current host header without loopback
  const host = configuredAdvertiseIp ? `${configuredAdvertiseIp}:${port}` : req.get('host') || `127.0.0.1:${port}`;
  // URL fragment format prevents secret from ever being transmitted to server via query strings
  const pairingUrl = `${protocol}://${host}/#secret=${activeInvitation.secret}`;

  try {
    const qrDataUrl = await QRCode.toDataURL(pairingUrl, {
      width: 320,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    });
    res.json({ pairingUrl, qrDataUrl, secret: activeInvitation.secret });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Client Pairing: POST /api/pair
app.post('/api/pair', (req: Request, res: Response) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  // Rate limiting / lock-out on failed attempts
  const attempt = failedPairingAttempts.get(clientIp);
  if (attempt && attempt.lockedUntil > now) {
    const secondsLeft = Math.ceil((attempt.lockedUntil - now) / 1000);
    return res.status(429).json({
      error: 'TOO_MANY_ATTEMPTS',
      message: `Too many failed pairing attempts. Please wait ${secondsLeft} seconds.`,
    });
  }

  const { secret } = req.body;
  const normalizedSecret = (secret || '').trim().toUpperCase();

  if (!isSharingActive) {
    return res.status(503).json({
      error: 'SHARING_HALTED',
      message: 'LocalDrop file sharing is currently stopped on the host PC.',
    });
  }

  // Check code expiry
  if (now > activeInvitation.expiresAt) {
    return res.status(400).json({
      error: 'SECRET_EXPIRED',
      message: 'This pairing code has expired. Please check the PC screen for the new code.',
    });
  }

  if (normalizedSecret !== activeInvitation.secret) {
    const count = (attempt?.count || 0) + 1;
    let lockedUntil = 0;
    if (count >= 5) {
      lockedUntil = now + 60 * 1000; // 1-minute lockout after 5 attempts
    }
    failedPairingAttempts.set(clientIp, { count, lockedUntil });
    return res.status(400).json({
      error: 'INVALID_SECRET',
      message: 'Incorrect pairing secret. Please verify the code displayed on your PC.',
    });
  }

  // Successful pairing: reset failed attempts
  failedPairingAttempts.delete(clientIp);

  const sessionId = crypto.randomUUID();
  const userAgent = req.headers['user-agent'] || 'Unknown Browser';
  const deviceLabel = parseDevice(userAgent);

  const newSession: ClientSession = {
    sessionId,
    clientIp,
    userAgent,
    deviceLabel,
    createdAt: now,
    expiresAt: now + sessionLifespanMs,
    lastActiveAt: now,
  };

  activeSessions.set(sessionId, newSession);

  // Set HttpOnly SameSite cookie
  res.cookie('localdrop_session', sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: sessionLifespanMs,
    path: '/',
  });

  logAudit('PAIR', `Device paired: ${deviceLabel}`, clientIp, deviceLabel);

  res.json({
    success: true,
    sessionId,
    deviceLabel,
    expiresIn: Math.floor(sessionLifespanMs / 1000),
  });
});

// Logout / Revoke current session
app.post('/api/logout', (req: Request, res: Response) => {
  const token = req.cookies?.localdrop_session || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (token && activeSessions.has(token)) {
    const s = activeSessions.get(token);
    activeSessions.delete(token);
    logAudit('REVOKE', `Client disconnected voluntarily: ${s?.deviceLabel || 'Client'}`);
  }
  res.clearCookie('localdrop_session');
  res.json({ success: true });
});

// ======================== FILE ENDPOINTS ========================

// GET /api/files - List shared files
app.get('/api/files', requireClientSession, (req: Request, res: Response) => {
  res.json({
    files: storedFiles,
    totalStorageUsed: getTotalStorageConsumed(),
    maxTotalStorage,
    maxFileSize,
  });
});

// POST /api/files - Upload file with bounded streaming & quota enforcement
app.post('/api/files', requireClientSession, (req: Request, res: Response) => {
  // Enforce incoming Content-Length check before allocating disk/buffers
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > maxFileSize + 1024 * 1024) {
    return res.status(413).json({
      error: 'FILE_TOO_LARGE',
      message: `File exceeds maximum allowed size of ${(maxFileSize / (1024 * 1024)).toFixed(0)} MiB.`,
    });
  }

  const currentUsage = getTotalStorageConsumed();
  if (currentUsage + contentLength > maxTotalStorage) {
    return res.status(507).json({
      error: 'QUOTA_EXCEEDED',
      message: 'Host storage quota would be exceeded by this upload.',
    });
  }

  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'FILE_TOO_LARGE',
          message: `File exceeds maximum allowed size of ${(maxFileSize / (1024 * 1024)).toFixed(0)} MiB.`,
        });
      }
      return res.status(400).json({ error: 'UPLOAD_ERROR', message: err.message });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'NO_FILE', message: 'No file provided in form-data.' });
    }

    const session = (req as any).clientSession as ClientSession;
    const tempPath = file.path;

    // Check actual disk size against quota
    const stats = fs.statSync(tempPath);
    if (currentUsage + stats.size > maxTotalStorage) {
      // Clean up temp file immediately
      fs.unlinkSync(tempPath);
      return res.status(507).json({
        error: 'QUOTA_EXCEEDED',
        message: 'Host storage quota reached. Upload aborted.',
      });
    }

    // Sanitize and preserve original filename
    const originalName = path.basename(file.originalname).replace(/[\0\r\n\t]/g, '').trim() || 'unnamed_file';
    const fileId = `file_${crypto.randomUUID().replace(/-/g, '')}`;
    const finalStoredPath = path.resolve(UPLOADS_DIR, fileId);

    // Atomically rename temp file to finalized fileId in uploads storage
    try {
      fs.renameSync(tempPath, finalStoredPath);
    } catch (renameErr) {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      return res.status(500).json({ error: 'STORAGE_ERROR', message: 'Could not store file.' });
    }

    const isVcard =
      originalName.toLowerCase().endsWith('.vcf') ||
      originalName.toLowerCase().endsWith('.vcard') ||
      file.mimetype.includes('vcard');

    const newRecord: StoredFile = {
      id: fileId,
      originalName,
      size: stats.size,
      mimeType: file.mimetype || 'application/octet-stream',
      uploadedAt: new Date().toISOString(),
      uploaderId: session.sessionId,
      uploaderDevice: session.deviceLabel,
      isVcard,
    };

    storedFiles.unshift(newRecord);
    saveFilesMetadata();

    logAudit('UPLOAD', `File uploaded: "${originalName}" (${(stats.size / 1024 / 1024).toFixed(2)} MB)`, session.clientIp, session.deviceLabel);

    res.status(201).json({
      success: true,
      file: newRecord,
    });
  });
});

// GET /api/files/:id/download - Stream file as attachment
app.get('/api/files/:id/download', requireClientSession, (req: Request, res: Response) => {
  const { id } = req.params;
  // Prevent path traversal
  if (!/^[a-zA-Z0-9_]+$/.test(id)) {
    return res.status(400).json({ error: 'INVALID_ID', message: 'Invalid file identifier.' });
  }

  const fileMeta = storedFiles.find((f) => f.id === id);
  const filePath = path.resolve(UPLOADS_DIR, id);

  if (!fileMeta || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'File not found on host.' });
  }

  const session = (req as any).clientSession as ClientSession;
  logAudit('DOWNLOAD', `File downloaded: "${fileMeta.originalName}"`, session.clientIp, session.deviceLabel);

  // Set Content-Disposition as attachment and prevent script execution of HTML/SVG
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(fileMeta.originalName)}"; filename*=UTF-8''${encodeURIComponent(fileMeta.originalName)}`
  );
  res.setHeader('Content-Type', 'application/octet-stream'); // Force download attachment
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

// DELETE /api/files/:id - Delete file (Admin or Paired client)
app.delete('/api/files/:id', requireClientSession, (req: Request, res: Response) => {
  const { id } = req.params;
  const index = storedFiles.findIndex((f) => f.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'File not found' });
  }

  const fileMeta = storedFiles[index];
  const filePath = path.resolve(UPLOADS_DIR, id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  storedFiles.splice(index, 1);
  saveFilesMetadata();

  logAudit('DELETE', `File removed: "${fileMeta.originalName}"`);
  res.json({ success: true });
});

// POST /api/files/batch-delete - Delete multiple selected files
app.post('/api/files/batch-delete', requireClientSession, (req: Request, res: Response) => {
  const { fileIds } = req.body;
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: 'INVALID_INPUT', message: 'No file IDs provided.' });
  }

  let deletedCount = 0;
  for (const id of fileIds) {
    if (!/^[a-zA-Z0-9_]+$/.test(id)) continue;
    const index = storedFiles.findIndex((f) => f.id === id);
    if (index !== -1) {
      const fileMeta = storedFiles[index];
      const filePath = path.resolve(UPLOADS_DIR, id);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {}
      }
      storedFiles.splice(index, 1);
      deletedCount++;
      logAudit('DELETE', `Batch deleted file: "${fileMeta.originalName}"`);
    }
  }

  saveFilesMetadata();
  res.json({ success: true, deletedCount });
});

// Helper for streaming zip archive of selected files
function streamBatchZip(fileIds: string[], req: Request, res: Response) {
  const validFiles = fileIds
    .filter((id: string) => /^[a-zA-Z0-9_]+$/.test(id))
    .map((id: string) => {
      const meta = storedFiles.find((f) => f.id === id);
      const filePath = path.resolve(UPLOADS_DIR, id);
      return { id, meta, filePath, exists: fs.existsSync(filePath) };
    })
    .filter((item) => item.meta && item.exists);

  if (validFiles.length === 0) {
    return res.status(404).json({ error: 'NO_FILES_FOUND', message: 'None of the requested files were found on disk.' });
  }

  const session = (req as any).clientSession as ClientSession;
  logAudit('DOWNLOAD', `Batch zip download initiated (${validFiles.length} files)`, session?.clientIp, session?.deviceLabel);

  const archive = new ZipArchive({ zlib: { level: 5 } });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="LocalDrop_Batch_${Date.now()}.zip"`
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');

  archive.on('error', (err: any) => {
    console.error('Archiver error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'ARCHIVE_ERROR', message: err.message });
    }
  });

  archive.pipe(res);

  const nameOccurrences = new Map<string, number>();

  for (const item of validFiles) {
    let entryName = item.meta!.originalName;
    const count = (nameOccurrences.get(entryName) || 0) + 1;
    nameOccurrences.set(entryName, count);

    if (count > 1) {
      const ext = path.extname(entryName);
      const base = path.basename(entryName, ext);
      entryName = `${base}_${count}${ext}`;
    }

    archive.file(item.filePath, { name: entryName });
  }

  archive.finalize();
}

// POST /api/files/batch-download
app.post('/api/files/batch-download', requireClientSession, (req: Request, res: Response) => {
  const { fileIds } = req.body;
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: 'INVALID_INPUT', message: 'No file IDs provided.' });
  }
  streamBatchZip(fileIds, req, res);
});

// GET /api/files/batch-download?ids=file_1,file_2
app.get('/api/files/batch-download', requireClientSession, (req: Request, res: Response) => {
  const idsQuery = req.query.ids;
  if (!idsQuery || typeof idsQuery !== 'string') {
    return res.status(400).json({ error: 'INVALID_INPUT', message: 'No file IDs provided in query.' });
  }
  const fileIds = idsQuery.split(',').map((s) => s.trim()).filter(Boolean);
  streamBatchZip(fileIds, req, res);
});

// ======================== PHASE 4: VCARD / CONTACTS PREVIEW ========================

interface ParsedContact {
  fn: string;
  names: { family?: string; given?: string };
  phones: { type: string; value: string }[];
  emails: { type: string; value: string }[];
  org?: string;
  title?: string;
  note?: string;
  isPossibleDuplicate?: boolean;
}

app.get('/api/files/:id/contacts-preview', requireClientSession, (req: Request, res: Response) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_]+$/.test(id)) {
    return res.status(400).json({ error: 'INVALID_ID' });
  }

  const fileMeta = storedFiles.find((f) => f.id === id);
  const filePath = path.resolve(UPLOADS_DIR, id);

  if (!fileMeta || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  // Safety limits: maximum 5 MB vcard file to avoid denial of service
  const stats = fs.statSync(filePath);
  if (stats.size > 5 * 1024 * 1024) {
    return res.status(413).json({
      error: 'VCF_TOO_LARGE',
      message: 'Contact file is too large for live preview (> 5 MiB). Download directly instead.',
    });
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Unfold lines (RFC 6350 / RFC 2425: CRLF followed by space or tab is folded line)
    const unfolded = content.replace(/\r?\n[ \t]/g, '');
    const lines = unfolded.split(/\r?\n/);

    const contacts: ParsedContact[] = [];
    let current: Partial<ParsedContact> | null = null;
    let contactCount = 0;
    const MAX_CONTACTS = 500; // Limit parsed contacts

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.toUpperCase() === 'BEGIN:VCARD') {
        current = {
          fn: '',
          names: {},
          phones: [],
          emails: [],
        };
        continue;
      }

      if (line.toUpperCase() === 'END:VCARD') {
        if (current && (current.fn || (current.phones && current.phones.length > 0))) {
          contacts.push({
            fn: current.fn || 'Unnamed Contact',
            names: current.names || {},
            phones: current.phones || [],
            emails: current.emails || [],
            org: current.org,
            title: current.title,
            note: current.note,
          });
          contactCount++;
          if (contactCount >= MAX_CONTACTS) break;
        }
        current = null;
        continue;
      }

      if (!current) continue;

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const propHeader = line.substring(0, colonIdx);
      // Escape and trim value
      const val = line.substring(colonIdx + 1).slice(0, 300).trim();
      const parts = propHeader.split(';');
      const propName = parts[0].toUpperCase();

      if (propName === 'FN') {
        current.fn = val;
      } else if (propName === 'N') {
        const nameParts = val.split(';');
        current.names = {
          family: nameParts[0] || '',
          given: nameParts[1] || '',
        };
        if (!current.fn) {
          current.fn = [nameParts[1], nameParts[0]].filter(Boolean).join(' ');
        }
      } else if (propName === 'TEL') {
        let type = 'Mobile';
        for (const p of parts.slice(1)) {
          if (p.toUpperCase().includes('WORK')) type = 'Work';
          else if (p.toUpperCase().includes('HOME')) type = 'Home';
          else if (p.toUpperCase().includes('CELL')) type = 'Cell';
          else if (p.toUpperCase().includes('FAX')) type = 'Fax';
        }
        current.phones?.push({ type, value: val });
      } else if (propName === 'EMAIL') {
        let type = 'Personal';
        for (const p of parts.slice(1)) {
          if (p.toUpperCase().includes('WORK')) type = 'Work';
        }
        current.emails?.push({ type, value: val });
      } else if (propName === 'ORG') {
        current.org = val.replace(/;/g, ' - ');
      } else if (propName === 'TITLE') {
        current.title = val;
      } else if (propName === 'NOTE') {
        current.note = val;
      }
    }

    // Duplicate detection: cautious normalization
    const phoneMap = new Map<string, number>();
    const nameMap = new Map<string, number>();

    for (const c of contacts) {
      const normName = c.fn.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normName) {
        nameMap.set(normName, (nameMap.get(normName) || 0) + 1);
      }
      for (const p of c.phones) {
        const cleanPhone = p.value.replace(/[^0-9]/g, '').slice(-10); // last 10 digits
        if (cleanPhone.length >= 7) {
          phoneMap.set(cleanPhone, (phoneMap.get(cleanPhone) || 0) + 1);
        }
      }
    }

    let duplicateCandidatesCount = 0;
    for (const c of contacts) {
      const normName = c.fn.toLowerCase().replace(/[^a-z0-9]/g, '');
      let hasDup = false;
      if (normName && (nameMap.get(normName) || 0) > 1) {
        hasDup = true;
      }
      for (const p of c.phones) {
        const cleanPhone = p.value.replace(/[^0-9]/g, '').slice(-10);
        if (cleanPhone.length >= 7 && (phoneMap.get(cleanPhone) || 0) > 1) {
          hasDup = true;
        }
      }
      c.isPossibleDuplicate = hasDup;
      if (hasDup) duplicateCandidatesCount++;
    }

    res.json({
      filename: fileMeta.originalName,
      totalContacts: contacts.length,
      duplicateCandidatesCount,
      contacts: contacts.slice(0, 200), // First 200 for snappy UI rendering
      truncated: contacts.length > 200,
      importGuidance: {
        ios: 'On iPhone: Tap "Download Attachment". Open the Files app or Safari Downloads, tap the .vcf file, and tap "Add all contacts" into your Contacts app.',
        android: 'On Android: Download the file. Tap the downloaded notification or open Contacts app > Settings/Fix & Manage > Import from .vcf file.',
        windowsMac: 'On PC/Mac: Double-click the downloaded .vcf file to import into Windows People, Outlook, or Apple Contacts.',
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: 'PARSE_ERROR', message: 'Failed to parse vCard: ' + err.message });
  }
});

// Seed sample dummy file so the user can test download immediately if desired
if (storedFiles.length === 0) {
  const welcomeFileId = `file_welcome_guide`;
  const welcomeFilePath = path.resolve(UPLOADS_DIR, welcomeFileId);
  if (!fs.existsSync(welcomeFilePath)) {
    fs.writeFileSync(
      welcomeFilePath,
      `=============================================================\n` +
      `Welcome to LocalDrop - Secure LAN File Transfer System\n` +
      `=============================================================\n\n` +
      `LocalDrop is your browser-based local-network transfer hub.\n\n` +
      `Key Security & Architecture Features:\n` +
      `- Temporary cryptographic pairing passcode (expires after 5 minutes)\n` +
      `- Zero cloud reliance: transfers stay strictly within your local Wi-Fi / LAN\n` +
      `- Clean isolation: dedicated app storage, never arbitrary filesystem paths\n` +
      `- Atomically finalized uploads with bounded disk writing & quotas\n` +
      `- Instant Host sharing halt to immediately revoke client file access\n\n` +
      `Try uploading photos, videos, documents, or .vcf contacts from your phone!\n`
    );
  }

  const sampleVcfId = `file_sample_contacts`;
  const sampleVcfPath = path.resolve(UPLOADS_DIR, sampleVcfId);
  if (!fs.existsSync(sampleVcfPath)) {
    fs.writeFileSync(
      sampleVcfPath,
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alex Chen\r\nN:Chen;Alex;;;\r\nTEL;TYPE=CELL:(555) 234-5678\r\nEMAIL;TYPE=WORK:alex.chen@example.com\r\nORG:Engineering Team\r\nTITLE:Software Architect\r\nEND:VCARD\r\n` +
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alex Chen\r\nN:Chen;Alex;;;\r\nTEL;TYPE=CELL:(555) 234-5678\r\nEMAIL;TYPE=HOME:alex.personal@example.com\r\nNOTE:Personal contact copy\r\nEND:VCARD\r\n` +
      `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Sarah Connor\r\nN:Connor;Sarah;;;\r\nTEL;TYPE=CELL:(555) 876-5432\r\nTEL;TYPE=WORK:(555) 876-0000\r\nEMAIL;TYPE=WORK:sarah@techcorp.io\r\nORG:Cyberdyne Security\r\nEND:VCARD\r\n`
    );
  }

  storedFiles.push(
    {
      id: welcomeFileId,
      originalName: 'Welcome_to_LocalDrop.txt',
      size: fs.statSync(welcomeFilePath).size,
      mimeType: 'text/plain',
      uploadedAt: new Date(Date.now() - 3600000).toISOString(),
      uploaderId: 'host_system',
      uploaderDevice: 'LocalDrop PC Host',
      isVcard: false,
    },
    {
      id: sampleVcfId,
      originalName: 'Sample_Team_Contacts.vcf',
      size: fs.statSync(sampleVcfPath).size,
      mimeType: 'text/vcard',
      uploadedAt: new Date().toISOString(),
      uploaderId: 'host_system',
      uploaderDevice: 'LocalDrop PC Host',
      isVcard: true,
    }
  );
  saveFilesMetadata();
}

// Start Server with Vite Middleware
async function startServer() {
  const portArgIndex = process.argv.indexOf('--port');
  const cliPort = portArgIndex !== -1 && process.argv[portArgIndex + 1] ? Number(process.argv[portArgIndex + 1]) : null;
  // Dev server must listen on port 3000 to work with the AI Studio proxy
  const PORT = cliPort || (process.env.NODE_ENV === 'production' && process.env.PORT && process.env.PORT !== '8080' ? Number(process.env.PORT) : 3000);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve static dist
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }

  const server = app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`LocalDrop server running on http://0.0.0.0:${PORT}`);
    console.log(`Configured LAN address: http://${configuredAdvertiseIp}:${PORT}`);
    console.log(`Active Pairing Secret: ${activeInvitation.secret}`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
    } else {
      console.error('Server listen error:', err);
    }
  });
}

startServer().catch((err) => {
  console.error('Failed to start LocalDrop server:', err);
});
