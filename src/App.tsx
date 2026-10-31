import React, { useState, useEffect, useRef } from 'react';
import {
  Wifi,
  WifiOff,
  Upload,
  Download,
  Trash2,
  QrCode,
  RefreshCw,
  FileText,
  Check,
  X,
  Copy,
  AlertCircle,
  CheckCircle2,
  HardDrive,
  Phone,
  Mail,
  LogOut
} from 'lucide-react';

interface StoredFile {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  uploaderId: string;
  uploaderDevice: string;
  isVcard: boolean;
}

interface ActiveSession {
  sessionId: string;
  clientIp: string;
  deviceLabel: string;
  userAgent: string;
  connectedAgo: number;
  expiresIn: number;
}

interface AdminStatus {
  isSharingActive: boolean;
  maxFileSize: number;
  maxTotalStorage: number;
  totalStorageUsed: number;
  pairingSecret: string;
  pairingExpiresInSeconds: number;
  advertiseIp: string;
  candidateIps: { name: string; ip: string; isDefault: boolean }[];
  activeSessions: ActiveSession[];
  fileCount: number;
}

interface UploadTask {
  id: string;
  file: File;
  progress: number;
  speed: string;
  status: 'queued' | 'uploading' | 'finishing' | 'done' | 'error';
  errorMessage?: string;
}

interface ParsedContact {
  fn: string;
  names?: { family?: string; given?: string };
  phones: { type: string; value: string }[];
  emails: { type: string; value: string }[];
  org?: string;
  title?: string;
  note?: string;
  isPossibleDuplicate?: boolean;
}

interface VcfPreviewData {
  filename: string;
  totalContacts: number;
  duplicateCandidatesCount: number;
  contacts: ParsedContact[];
  truncated: boolean;
  importGuidance: {
    ios: string;
    android: string;
    windowsMac: string;
  };
}

export default function App() {
  // Navigation: 'client' (main transfer view) or 'admin' (host controls)
  const [currentView, setCurrentView] = useState<'client' | 'admin'>('client');

  // Server Admin Status
  const [adminStatus, setAdminStatus] = useState<AdminStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // Client Session State
  const [isPaired, setIsPaired] = useState<boolean>(false);
  const [clientSessionId, setClientSessionId] = useState<string>('');
  const [clientDeviceLabel, setClientDeviceLabel] = useState<string>('');
  const [pairingCodeInput, setPairingCodeInput] = useState<string>('');
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState<boolean>(false);
  const [pairingLoading, setPairingLoading] = useState(false);

  // Files State
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);

  // Uploads & Drag-and-drop
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // VCF Preview Modal
  const [vcfPreview, setVcfPreview] = useState<VcfPreviewData | null>(null);
  const [, setVcfLoading] = useState(false);
  const [, setSelectedVcfId] = useState<string | null>(null);

  // Fetch host admin status
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/admin/status');
      if (res.ok) {
        const data = await res.json();
        setAdminStatus(data);
      }
    } catch (err) {
      console.error('Status fetch failed:', err);
    }
  };

  // Fetch pairing QR code
  const fetchQr = async () => {
    try {
      const res = await fetch('/api/admin/pairing-qr');
      if (res.ok) {
        const data = await res.json();
        setQrDataUrl(data.qrDataUrl);
      }
    } catch (err) {
      console.error('QR fetch failed:', err);
    }
  };

  // Fetch shared files
  const fetchFiles = async () => {
    if (!isPaired && !clientSessionId) return;
    setFilesLoading(true);
    try {
      const headers: Record<string, string> = {};
      if (clientSessionId) {
        headers['Authorization'] = `Bearer ${clientSessionId}`;
      }
      const res = await fetch('/api/files', { credentials: 'include', headers });
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files || []);
        setSessionExpired(false);
      } else if (res.status === 401 || res.status === 503) {
        setIsPaired(false);
        setClientSessionId('');
        if (res.status === 401) {
          setSessionExpired(true);
        }
      }
    } catch (err) {
      console.error('Files fetch failed:', err);
    } finally {
      setFilesLoading(false);
    }
  };

  // Initial setup & URL fragment check
  useEffect(() => {
    fetchStatus();
    fetchQr();

    const timer = setInterval(() => {
      fetchStatus();
    }, 4000);

    // URL fragment redemption for QR codes: #secret=XXXXXX
    const hash = window.location.hash;
    if (hash && hash.includes('secret=')) {
      const match = hash.match(/secret=([A-Za-z0-9]+)/);
      if (match && match[1]) {
        const secret = match[1];
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        submitPairing(secret);
      }
    }

    return () => clearInterval(timer);
  }, []);

  // Poll files when paired
  useEffect(() => {
    if (isPaired) {
      fetchFiles();
      const filesTimer = setInterval(fetchFiles, 5000);
      return () => clearInterval(filesTimer);
    }
  }, [isPaired, clientSessionId]);

  // Pair with secret
  const submitPairing = async (codeToUse?: string) => {
    const code = (codeToUse || pairingCodeInput).trim().toUpperCase();
    if (!code) {
      setPairingError('Enter the pairing code shown on the host computer.');
      return;
    }
    setPairingLoading(true);
    setPairingError(null);
    setSessionExpired(false);

    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ secret: code }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setIsPaired(true);
        setClientSessionId(data.sessionId);
        setClientDeviceLabel(data.deviceLabel || 'Connected Device');
        setPairingCodeInput('');
        fetchStatus();
      } else {
        setPairingError('That code is invalid or has expired. Check the code or ask the owner for a new one.');
      }
    } catch (err) {
      setPairingError('That code is invalid or has expired. Check the code or ask the owner for a new one.');
    } finally {
      setPairingLoading(false);
    }
  };

  // Disconnect session
  const handleDisconnect = async () => {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        credentials: 'include',
        headers: clientSessionId ? { Authorization: `Bearer ${clientSessionId}` } : {},
      });
    } catch (e) {}
    setIsPaired(false);
    setClientSessionId('');
    setSelectedFileIds([]);
    fetchStatus();
  };

  // Host toggle sharing
  const handleToggleSharing = async () => {
    if (!adminStatus) return;
    try {
      const res = await fetch('/api/admin/toggle-sharing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !adminStatus.isSharingActive }),
      });
      if (res.ok) {
        fetchStatus();
      }
    } catch (err) {
      console.error('Sharing toggle error:', err);
    }
  };

  // Regenerate pairing invite
  const handleRegeneratePin = async () => {
    try {
      const res = await fetch('/api/admin/regenerate-invite', { method: 'POST' });
      if (res.ok) {
        await fetchStatus();
        await fetchQr();
      }
    } catch (err) {
      console.error('PIN regenerate failed:', err);
    }
  };

  // Revoke session
  const handleRevokeSession = async (sessionId: string) => {
    try {
      await fetch('/api/admin/revoke-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      fetchStatus();
    } catch (err) {
      console.error('Revoke failed:', err);
    }
  };

  // Upload Files with honest XHR progress (showing "Finishing…" after 100% until backend stores)
  const handleFilesSelected = (selectedList: FileList | null) => {
    if (!selectedList || selectedList.length === 0) return;

    const newTasks: UploadTask[] = Array.from(selectedList).map((file) => ({
      id: Math.random().toString(36).substring(2, 9),
      file,
      progress: 0,
      speed: '',
      status: 'queued',
    }));

    setUploadTasks((prev) => [...newTasks, ...prev]);

    newTasks.forEach((task) => {
      uploadSingleFile(task);
    });
  };

  const uploadSingleFile = (task: UploadTask) => {
    const formData = new FormData();
    formData.append('file', task.file);

    const xhr = new XMLHttpRequest();
    const startTime = Date.now();
    let lastLoaded = 0;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
        const elapsed = Math.max(0.1, (Date.now() - startTime) / 1000);
        const bytesPerSec = (e.loaded - lastLoaded) / elapsed;
        const mbps = (bytesPerSec / (1024 * 1024)).toFixed(1);

        setUploadTasks((prev) =>
          prev.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  progress: percent,
                  speed: percent === 100 ? '' : `${mbps} MB/s`,
                  status: percent === 100 ? 'finishing' : 'uploading',
                }
              : t
          )
        );
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setUploadTasks((prev) =>
          prev.map((t) =>
            t.id === task.id ? { ...t, progress: 100, status: 'done', speed: '' } : t
          )
        );
        fetchFiles();
        fetchStatus();
      } else if (xhr.status === 401) {
        setIsPaired(false);
        setClientSessionId('');
        setSessionExpired(true);
        setUploadTasks((prev) =>
          prev.map((t) =>
            t.id === task.id ? { ...t, status: 'error', errorMessage: 'Upload failed. Try again.' } : t
          )
        );
      } else {
        setUploadTasks((prev) =>
          prev.map((t) =>
            t.id === task.id ? { ...t, status: 'error', errorMessage: 'Upload failed. Try again.' } : t
          )
        );
      }
    });

    xhr.addEventListener('error', () => {
      setUploadTasks((prev) =>
        prev.map((t) =>
          t.id === task.id
            ? { ...t, status: 'error', errorMessage: 'Upload failed. Try again.' }
            : t
        )
      );
    });

    xhr.open('POST', '/api/files');
    if (clientSessionId) {
      xhr.setRequestHeader('Authorization', `Bearer ${clientSessionId}`);
    }
    xhr.withCredentials = true;
    xhr.send(formData);
  };

  // Delete file
  const handleDeleteFile = async (fileId: string) => {
    if (!confirm('Remove this file from the shared list?')) return;
    try {
      const headers: Record<string, string> = {};
      if (clientSessionId) headers['Authorization'] = `Bearer ${clientSessionId}`;
      const res = await fetch(`/api/files/${fileId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers,
      });
      if (res.ok) {
        setSelectedFileIds((prev) => prev.filter((id) => id !== fileId));
        fetchFiles();
        fetchStatus();
      }
    } catch (err) {
      console.error('Delete error:', err);
    }
  };

  // Batch delete
  const handleBatchDelete = async () => {
    if (selectedFileIds.length === 0) return;
    if (!confirm(`Delete ${selectedFileIds.length} selected file(s)?`)) return;

    setIsBatchProcessing(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (clientSessionId) headers['Authorization'] = `Bearer ${clientSessionId}`;
      const res = await fetch('/api/files/batch-delete', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ fileIds: selectedFileIds }),
      });
      if (res.ok) {
        setSelectedFileIds([]);
        fetchFiles();
        fetchStatus();
      }
    } catch (err) {
      console.error('Batch delete failed:', err);
    } finally {
      setIsBatchProcessing(false);
    }
  };

  // Batch download
  const handleBatchDownload = () => {
    if (selectedFileIds.length === 0) return;
    if (selectedFileIds.length === 1) {
      const single = files.find((f) => f.id === selectedFileIds[0]);
      const link = document.createElement('a');
      link.href = `/api/files/${selectedFileIds[0]}/download`;
      link.download = single?.originalName || 'download';
      link.click();
      return;
    }
    const link = document.createElement('a');
    link.href = `/api/files/batch-download?ids=${selectedFileIds.join(',')}`;
    link.download = `LocalDrop_Batch_${Date.now()}.zip`;
    link.click();
  };

  // Preview VCF
  const handlePreviewVcf = async (fileId: string) => {
    setSelectedVcfId(fileId);
    setVcfLoading(true);
    setVcfPreview(null);
    try {
      const headers: Record<string, string> = {};
      if (clientSessionId) headers['Authorization'] = `Bearer ${clientSessionId}`;
      const res = await fetch(`/api/files/${fileId}/contacts-preview`, {
        credentials: 'include',
        headers,
      });
      if (res.ok) {
        const data = await res.json();
        setVcfPreview(data);
      }
    } catch (e) {
      console.error('VCF preview failed:', e);
    } finally {
      setVcfLoading(false);
    }
  };

  // Selection toggles
  const toggleSelectFile = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSelectedFileIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    const filteredIds = filteredFiles.map((f) => f.id);
    const areAllSelected =
      filteredIds.length > 0 && filteredIds.every((id) => selectedFileIds.includes(id));
    if (areAllSelected) {
      setSelectedFileIds((prev) => prev.filter((id) => !filteredIds.includes(id)));
    } else {
      setSelectedFileIds((prev) => Array.from(new Set([...prev, ...filteredIds])));
    }
  };

  // Format bytes
  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopyFeedback(label);
    setTimeout(() => setCopyFeedback(null), 2500);
  };

  // Filter files
  const filteredFiles = files.filter((f) =>
    f.originalName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const selectedFiles = files.filter((f) => selectedFileIds.includes(f.id));
  const totalSelectedBytes = selectedFiles.reduce((acc, f) => acc + (f.size || 0), 0);
  const areAllSelected =
    filteredFiles.length > 0 &&
    filteredFiles.every((f) => selectedFileIds.includes(f.id));
  const isSomeSelected =
    filteredFiles.some((f) => selectedFileIds.includes(f.id)) && !areAllSelected;

  const lanDestinationUrl = adminStatus?.advertiseIp
    ? `http://${adminStatus.advertiseIp}:${window.location.port || 3000}`
    : `http://127.0.0.1:3000`;

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] font-sans antialiased flex flex-col">
      {/* 1. Compact Header */}
      <header className="bg-white border-b border-[#E2E8F0] sticky top-0 z-30">
        <div className="max-w-[1040px] mx-auto px-4 h-14 flex items-center justify-between">
          {/* Logo & Connection Status */}
          <div className="flex items-center space-x-3">
            <span className="font-bold text-base tracking-tight text-[#0F172A]">
              LocalDrop
            </span>

            {/* Connection Status Badge */}
            {adminStatus && (
              <span
                className={`inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                  adminStatus.isSharingActive
                    ? 'bg-[#F0FDF4] text-[#16A34A] border-[#BBF7D0]'
                    : 'bg-[#FFFBEB] text-[#D97706] border-[#FDE68A]'
                }`}
                title={adminStatus.isSharingActive ? 'Sharing active' : 'Sharing stopped'}
              >
                {adminStatus.isSharingActive ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-[#16A34A]" aria-hidden="true" />
                    <span className="hidden xs:inline sm:inline">Sharing active</span>
                  </>
                ) : (
                  <>
                    <WifiOff className="w-3 h-3 text-[#D97706]" aria-hidden="true" />
                    <span className="hidden xs:inline sm:inline">Sharing stopped</span>
                  </>
                )}
              </span>
            )}
          </div>

          {/* Navigation Controls */}
          <div className="flex items-center space-x-2">
            <div className="inline-flex rounded-lg p-0.5 bg-[#F1F5F9] border border-[#E2E8F0] text-xs">
              <button
                type="button"
                onClick={() => setCurrentView('client')}
                className={`px-3 py-1 rounded-md font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none ${
                  currentView === 'client'
                    ? 'bg-white text-[#0F172A] shadow-xs'
                    : 'text-[#475569] hover:text-[#0F172A]'
                }`}
              >
                Transfer
              </button>
              <button
                type="button"
                onClick={() => setCurrentView('admin')}
                className={`px-3 py-1 rounded-md font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none ${
                  currentView === 'admin'
                    ? 'bg-white text-[#0F172A] shadow-xs'
                    : 'text-[#475569] hover:text-[#0F172A]'
                }`}
              >
                Host controls
              </button>
            </div>

            <button
              type="button"
              onClick={() => setQrModalOpen(true)}
              className="p-1.5 rounded-lg border border-[#E2E8F0] bg-white text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none"
              title="Show pairing QR code"
              aria-label="Show pairing QR code"
            >
              <QrCode className="w-4 h-4 text-[#4338CA]" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-[1040px] w-full mx-auto px-4 py-8">
        {/* 2. Concise Title & Supporting Sentence */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-[#0F172A]">
            Share files. <strong>Stay local.</strong>
          </h1>
          <p className="text-sm text-[#475569] mt-1">
            Move files between devices on the <strong>same Wi-Fi</strong>.
          </p>
        </div>

        {/* Sharing stopped alert */}
        {adminStatus && !adminStatus.isSharingActive && (
          <div
            role="alert"
            className="mb-6 p-4 rounded-[14px] bg-[#FFFBEB] border border-[#FDE68A] text-sm flex items-start gap-3"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[#D97706]" aria-hidden="true" />
            <div className="flex-1">
              <h2 className="font-semibold text-[#0F172A]">Sharing has stopped.</h2>
              <p className="text-xs text-[#475569] mt-0.5">
                The owner is no longer accepting file transfers.
              </p>
            </div>
            {currentView === 'admin' && (
              <button
                type="button"
                onClick={handleToggleSharing}
                className="px-3 py-1 bg-[#4338CA] hover:bg-[#3730A3] text-white rounded-md text-xs font-medium focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none"
              >
                Resume
              </button>
            )}
          </div>
        )}

        {/* Top 2-Column Grid: Left Upload Card, Right Pairing/Session Card */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Main Upload Card (Left / 7 cols) */}
          <div className="lg:col-span-7">
            <section
              aria-labelledby="upload-heading"
              className="bg-white border border-[#E2E8F0] rounded-[14px] p-6 shadow-xs h-full flex flex-col justify-between"
            >
              <div>
                <h2 id="upload-heading" className="text-base font-semibold text-[#0F172A]">
                  Choose files to share
                </h2>
                <p className="text-xs text-[#475569] mt-0.5">
                  Drag and drop files here, or choose files.
                </p>

                {/* Drop area */}
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragOver(true);
                  }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragOver(false);
                    handleFilesSelected(e.dataTransfer.files);
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  className={`mt-4 border-2 border-dashed rounded-[14px] p-8 text-center transition-colors cursor-pointer ${
                    isDragOver
                      ? 'border-[#4338CA] bg-[#EEF2FF]'
                      : 'border-[#CBD5E1] hover:border-[#94A3B8] bg-[#F8FAFC]'
                  }`}
                >
                  <input
                    type="file"
                    multiple
                    ref={fileInputRef}
                    onChange={(e) => handleFilesSelected(e.target.files)}
                    className="hidden"
                    aria-label="Upload files"
                  />

                  <div className="w-10 h-10 rounded-full bg-[#EEF2FF] text-[#4338CA] flex items-center justify-center mx-auto mb-3">
                    <Upload className="w-5 h-5" aria-hidden="true" />
                  </div>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                    className="px-4 py-2 bg-[#4338CA] hover:bg-[#3730A3] text-white text-xs font-semibold rounded-lg shadow-xs transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none"
                  >
                    Choose files
                  </button>

                  <p className="text-xs text-[#475569] mt-3">
                    Max <strong>100 MB</strong> per file.
                  </p>
                </div>
              </div>

              {/* Upload Progress Queue */}
              {uploadTasks.length > 0 && (
                <div className="mt-5 space-y-2.5 pt-4 border-t border-[#E2E8F0]">
                  <div className="flex items-center justify-between text-xs text-[#475569]">
                    <span className="font-medium">Active transfers</span>
                    <button
                      type="button"
                      onClick={() => setUploadTasks([])}
                      className="text-[#4338CA] hover:underline font-medium focus-visible:ring-2 focus-visible:ring-[#4338CA] rounded"
                    >
                      Clear list
                    </button>
                  </div>

                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {uploadTasks.map((task) => (
                      <div
                        key={task.id}
                        className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3 text-xs"
                      >
                        <div className="flex items-center justify-between mb-1.5 gap-2">
                          <span className="font-medium text-[#0F172A] truncate min-w-0" title={task.file.name}>
                            {task.file.name}
                          </span>
                          <span className="text-[#475569] text-[11px] font-mono shrink-0">
                            {formatBytes(task.file.size)}
                          </span>
                        </div>

                        {/* Progress bar */}
                        <div className="w-full h-1.5 bg-[#E2E8F0] rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-200 ${
                              task.status === 'done'
                                ? 'bg-[#16A34A]'
                                : task.status === 'error'
                                ? 'bg-[#DC2626]'
                                : 'bg-[#4338CA]'
                            }`}
                            style={{ width: `${task.progress}%` }}
                          />
                        </div>

                        {/* Readable Status Message */}
                        <div className="flex items-center justify-between mt-1.5 text-[11px]">
                          <span className="font-medium">
                            {task.status === 'done' && (
                              <span className="text-[#16A34A] inline-flex items-center gap-1">
                                <Check className="w-3 h-3 stroke-[2.5]" />
                                File ready to share
                              </span>
                            )}
                            {task.status === 'uploading' && (
                              <span className="text-[#4338CA]">Uploading…</span>
                            )}
                            {task.status === 'finishing' && (
                              <span className="text-[#4338CA]">Finishing…</span>
                            )}
                            {task.status === 'error' && (
                              <span className="text-[#DC2626]">
                                {task.errorMessage || 'Upload failed. Try again.'}
                              </span>
                            )}
                          </span>
                          <span className="text-[#475569] font-mono">{task.speed}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>

          {/* Secondary Panel Column (Right / 5 cols) */}
          <div className="lg:col-span-5 space-y-4">
            {/* Pairing or Session Information Card */}
            {currentView === 'admin' ? (
              /* Host Administrator Controls */
              <div className="bg-white border border-[#E2E8F0] rounded-[14px] p-5 shadow-xs space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-[#E2E8F0]">
                  <div>
                    <h3 className="text-sm font-semibold text-[#0F172A]">Host administrator</h3>
                    <p className="text-[11px] text-[#475569]">Controls for this PC.</p>
                  </div>
                  <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-[#F1F5F9] text-[#475569] font-medium border border-[#E2E8F0]">
                    Local
                  </span>
                </div>

                {/* Pairing Secret Display */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-[#475569] font-medium">Temporary pairing PIN</span>
                    <button
                      type="button"
                      onClick={handleRegeneratePin}
                      className="text-[11px] text-[#4338CA] hover:underline font-medium flex items-center gap-1 focus-visible:ring-2 focus-visible:ring-[#4338CA] rounded"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>New code</span>
                    </button>
                  </div>

                  <div className="p-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg text-center">
                    <span className="text-2xl font-mono font-bold tracking-widest text-[#4338CA]">
                      {adminStatus?.pairingSecret || '------'}
                    </span>
                    <p className="text-[11px] text-[#475569] mt-1">
                      Expires in <strong>{adminStatus?.pairingExpiresInSeconds || 0}s</strong>
                    </p>
                  </div>
                </div>

                {/* LAN Address */}
                <div>
                  <span className="text-xs text-[#475569] font-medium block mb-1">
                    LAN address for other devices
                  </span>
                  <div className="flex items-center justify-between bg-[#F8FAFC] border border-[#E2E8F0] px-3 py-1.5 rounded-lg text-xs font-mono text-[#0F172A]">
                    <span className="truncate">{lanDestinationUrl}</span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(lanDestinationUrl, 'URL')}
                      className="p-1 text-[#475569] hover:text-[#0F172A] focus-visible:ring-2 focus-visible:ring-[#4338CA] rounded"
                      title="Copy LAN address"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {copyFeedback === 'URL' && (
                    <span className="text-[11px] text-[#16A34A] block mt-1">Copied to clipboard</span>
                  )}
                </div>

                {/* QR Code Action */}
                <button
                  type="button"
                  onClick={() => setQrModalOpen(true)}
                  className="w-full py-2 bg-[#F8FAFC] hover:bg-[#F1F5F9] border border-[#E2E8F0] text-[#0F172A] text-xs font-medium rounded-lg flex items-center justify-center gap-2 transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none"
                >
                  <QrCode className="w-3.5 h-3.5 text-[#4338CA]" />
                  <span>Show phone QR code</span>
                </button>

                {/* Active Connected Devices */}
                <div className="pt-3 border-t border-[#E2E8F0]">
                  <span className="text-xs text-[#475569] font-medium block mb-2">
                    Connected devices ({adminStatus?.activeSessions.length || 0})
                  </span>

                  {adminStatus?.activeSessions.length === 0 ? (
                    <p className="text-[11px] text-[#94A3B8]">No external devices currently paired.</p>
                  ) : (
                    <div className="space-y-2 max-h-36 overflow-y-auto">
                      {adminStatus?.activeSessions.map((s) => (
                        <div
                          key={s.sessionId}
                          className="flex items-center justify-between p-2 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] text-xs"
                        >
                          <div>
                            <div className="font-medium text-[#0F172A]">{s.deviceLabel}</div>
                            <div className="text-[10px] text-[#475569] font-mono">
                              IP: {s.clientIp}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleRevokeSession(s.sessionId)}
                            className="text-[11px] text-[#DC2626] hover:underline font-medium focus-visible:ring-2 focus-visible:ring-[#DC2626] rounded"
                          >
                            Revoke
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Owner-Only Stop Action */}
                <div className="pt-3 border-t border-[#E2E8F0]">
                  <button
                    type="button"
                    onClick={handleToggleSharing}
                    className={`w-full py-2 px-3 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-2 focus-visible:ring-2 focus-visible:ring-offset-2 outline-none ${
                      adminStatus?.isSharingActive
                        ? 'bg-[#FEF2F2] hover:bg-[#FEE2E2] text-[#DC2626] border border-[#FECACA] focus-visible:ring-[#DC2626]'
                        : 'bg-[#4338CA] hover:bg-[#3730A3] text-white focus-visible:ring-[#4338CA]'
                    }`}
                  >
                    {adminStatus?.isSharingActive ? (
                      <>
                        <WifiOff className="w-3.5 h-3.5" />
                        <span>Stop sharing</span>
                      </>
                    ) : (
                      <>
                        <Wifi className="w-3.5 h-3.5" />
                        <span>Start sharing</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              /* Client Pairing / Session Panel */
              <div className="bg-white border border-[#E2E8F0] rounded-[14px] p-5 shadow-xs space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-[#E2E8F0]">
                  <h3 className="text-sm font-semibold text-[#0F172A]">Connect your device</h3>
                  <span className="text-[10px] text-[#475569] font-mono">LAN</span>
                </div>

                {sessionExpired && (
                  <div
                    role="alert"
                    className="p-3 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] text-xs space-y-0.5"
                  >
                    <div className="font-semibold">Your session has expired.</div>
                    <div>Reconnect using a new pairing code.</div>
                  </div>
                )}

                {!isPaired ? (
                  <div className="space-y-3">
                    <p className="text-xs text-[#475569]">
                      Enter the pairing code shown on the host computer.
                    </p>

                    {pairingError && (
                      <div
                        role="alert"
                        className="p-2.5 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] text-xs"
                      >
                        {pairingError}
                      </div>
                    )}

                    <div>
                      <label htmlFor="pin-input" className="sr-only">
                        Pairing code
                      </label>
                      <input
                        id="pin-input"
                        type="text"
                        maxLength={8}
                        placeholder="Code (e.g. 7K9X2B)"
                        value={pairingCodeInput}
                        onChange={(e) => setPairingCodeInput(e.target.value.toUpperCase())}
                        onKeyDown={(e) => e.key === 'Enter' && submitPairing()}
                        className="w-full text-center font-mono text-lg font-bold tracking-widest uppercase bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-[#0F172A] focus:bg-white focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => submitPairing()}
                      disabled={pairingLoading}
                      className="w-full py-2 bg-[#4338CA] hover:bg-[#3730A3] disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none"
                    >
                      {pairingLoading ? 'Connecting…' : 'Connect'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center space-x-2 text-xs text-[#16A34A] font-medium">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Paired as {clientDeviceLabel}</span>
                    </div>

                    <p className="text-xs text-[#475569]">
                      Your session is active for 30 minutes on this local network.
                    </p>

                    <button
                      type="button"
                      onClick={handleDisconnect}
                      className="w-full py-2 border border-[#E2E8F0] hover:bg-[#F8FAFC] text-[#475569] hover:text-[#0F172A] text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>Disconnect session</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Storage Quota Card */}
            <div className="bg-white border border-[#E2E8F0] rounded-[14px] p-5 shadow-xs">
              <div className="flex items-center justify-between text-xs mb-1.5 font-medium">
                <span className="text-[#475569] flex items-center gap-1.5">
                  <HardDrive className="w-3.5 h-3.5 text-[#4338CA]" />
                  <span>Storage quota</span>
                </span>
                <span className="font-mono text-[#0F172A]">
                  {formatBytes(adminStatus?.totalStorageUsed || 0)} / {formatBytes(adminStatus?.maxTotalStorage || 1073741824)}
                </span>
              </div>
              <div className="w-full h-1.5 bg-[#E2E8F0] rounded-full overflow-hidden">
                <div
                  className="bg-[#4338CA] h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.min(
                      100,
                      adminStatus
                        ? ((adminStatus.totalStorageUsed || 0) / adminStatus.maxTotalStorage) * 100
                        : 0
                    )}%`,
                  }}
                />
              </div>
              <p className="text-[11px] text-[#475569] mt-2">
                Stored in isolated application directory on the PC host.
              </p>
            </div>

            {/* Shared-access notice & HTTP notice */}
            <div className="bg-white border border-[#E2E8F0] rounded-[14px] p-5 shadow-xs space-y-3">
              <p className="text-xs text-[#475569] leading-relaxed">
                Paired devices can access the files in this shared space.
              </p>
              <p className="text-xs text-[#475569] pt-3 border-t border-[#E2E8F0] leading-relaxed">
                This connection is not encrypted. Use it only on a trusted network.
              </p>
            </div>
          </div>
        </div>

        {/* 4. Full-Width Shared Files List Below */}
        <section
          aria-labelledby="files-heading"
          className="mt-6 bg-white border border-[#E2E8F0] rounded-[14px] p-6 shadow-xs"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[#E2E8F0]">
            <div>
              <h2 id="files-heading" className="text-base font-semibold text-[#0F172A]">
                Shared files
              </h2>
            </div>

            {/* Search & Refresh */}
            <div className="flex items-center space-x-2">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search files…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="px-3 py-1.5 text-xs bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg text-[#0F172A] placeholder-[#94A3B8] focus:bg-white focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none w-48"
                  aria-label="Search shared files"
                />
              </div>
              <button
                type="button"
                onClick={fetchFiles}
                disabled={filesLoading}
                className="p-1.5 border border-[#E2E8F0] bg-white rounded-lg text-[#475569] hover:text-[#0F172A] hover:bg-[#F8FAFC] transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none"
                title="Refresh files"
                aria-label="Refresh files"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${filesLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* Select all header bar */}
          {filteredFiles.length > 0 && (
            <div className="mt-4 flex items-center justify-between py-2 px-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg text-xs">
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  className={`w-4 h-4 rounded border flex items-center justify-center transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] outline-none ${
                    areAllSelected
                      ? 'bg-[#4338CA] border-[#4338CA] text-white'
                      : isSomeSelected
                      ? 'bg-[#EEF2FF] border-[#4338CA] text-[#4338CA]'
                      : 'border-[#CBD5E1] bg-white'
                  }`}
                  aria-label={areAllSelected ? 'Deselect all files' : 'Select all files'}
                >
                  {areAllSelected && <Check className="w-3 h-3 stroke-[3]" />}
                  {isSomeSelected && <span className="w-1.5 h-0.5 bg-[#4338CA]" />}
                </button>
                <span
                  onClick={toggleSelectAll}
                  className="text-[#475569] font-medium cursor-pointer select-none"
                >
                  Select all ({filteredFiles.length})
                </span>
              </div>

              {selectedFileIds.length > 0 && (
                <div className="flex items-center space-x-2">
                  <span className="font-mono text-[11px] text-[#4338CA] bg-[#EEF2FF] px-2 py-0.5 rounded font-semibold">
                    {selectedFileIds.length} selected ({formatBytes(totalSelectedBytes)})
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedFileIds([])}
                    className="text-[11px] text-[#475569] hover:text-[#0F172A] font-medium focus-visible:ring-2 focus-visible:ring-[#4338CA] rounded"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Files Rows or Empty State */}
          <div className="mt-3">
            {filteredFiles.length === 0 ? (
              <div className="py-12 text-center">
                <div className="w-10 h-10 rounded-full bg-[#F1F5F9] text-[#94A3B8] flex items-center justify-center mx-auto mb-2">
                  <FileText className="w-5 h-5" aria-hidden="true" />
                </div>
                <h3 className="text-sm font-semibold text-[#0F172A]">No files shared yet</h3>
                <p className="text-xs text-[#475569] mt-0.5 max-w-sm mx-auto">
                  Upload a file to make it available to paired devices.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[#E2E8F0]">
                {filteredFiles.map((file) => {
                  const isSelected = selectedFileIds.includes(file.id);
                  return (
                    <div
                      key={file.id}
                      onClick={() => toggleSelectFile(file.id)}
                      className={`py-3 px-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-3 rounded-lg transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-[#EEF2FF]'
                          : 'hover:bg-[#F8FAFC]'
                      }`}
                    >
                      <div className="flex items-start sm:items-center space-x-3 min-w-0 flex-1">
                        {/* Checkbox */}
                        <button
                          type="button"
                          onClick={(e) => toggleSelectFile(file.id, e)}
                          className={`mt-0.5 sm:mt-0 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] outline-none ${
                            isSelected
                              ? 'bg-[#4338CA] border-[#4338CA] text-white'
                              : 'border-[#CBD5E1] bg-white'
                          }`}
                          aria-label={isSelected ? 'Deselect file' : 'Select file'}
                        >
                          {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                        </button>

                        <FileText className="mt-0.5 sm:mt-0 w-4 h-4 text-[#4338CA] shrink-0" aria-hidden="true" />

                        <div className="min-w-0 flex-1">
                          <span
                            className="text-xs font-semibold text-[#0F172A] [word-break:break-word] break-words line-clamp-2 sm:line-clamp-1 block"
                            title={file.originalName}
                          >
                            {file.originalName}
                          </span>
                          <div className="text-[11px] text-[#475569] flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 font-mono">
                            <span>{formatBytes(file.size)}</span>
                            <span>•</span>
                            <span className="truncate max-w-[140px] sm:max-w-[200px]">{file.uploaderDevice}</span>
                          </div>
                        </div>
                      </div>

                      {/* Row Actions */}
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center space-x-2 shrink-0 self-end sm:self-center pl-7 sm:pl-0"
                      >
                        {file.isVcard && (
                          <button
                            type="button"
                            onClick={() => handlePreviewVcf(file.id)}
                            className="px-2.5 py-1.5 rounded-md text-xs font-medium border border-[#E2E8F0] bg-white text-[#4338CA] hover:bg-[#EEF2FF] transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] outline-none"
                          >
                            Preview contacts
                          </button>
                        )}

                        <a
                          href={`/api/files/${file.id}/download`}
                          download={file.originalName}
                          className="px-3 py-1.5 rounded-md text-xs font-medium border border-[#E2E8F0] bg-white text-[#0F172A] hover:bg-[#F8FAFC] transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] outline-none"
                        >
                          Download
                        </a>

                        <button
                          type="button"
                          onClick={() => handleDeleteFile(file.id)}
                          className="p-1.5 text-[#94A3B8] hover:text-[#DC2626] rounded transition-colors focus-visible:ring-2 focus-visible:ring-[#DC2626] outline-none"
                          title="Delete file"
                          aria-label="Delete file"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Floating Batch Actions Toolbar */}
      {selectedFileIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 w-[94%] max-w-md">
          <div className="p-3 rounded-[14px] bg-white border border-[#CBD5E1] shadow-lg flex items-center justify-between gap-3">
            <div className="flex items-center space-x-2 pl-1 min-w-0">
              <span className="w-6 h-6 rounded-md bg-[#4338CA] text-white text-xs font-bold flex items-center justify-center shrink-0">
                {selectedFileIds.length}
              </span>
              <div className="min-w-0">
                <span className="text-xs font-semibold text-[#0F172A] block truncate">
                  {selectedFileIds.length} selected
                </span>
                <span className="text-[11px] text-[#475569] font-mono">
                  {formatBytes(totalSelectedBytes)}
                </span>
              </div>
            </div>

            <div className="flex items-center space-x-2 shrink-0">
              <button
                type="button"
                onClick={handleBatchDownload}
                className="px-3 py-1.5 bg-[#4338CA] hover:bg-[#3730A3] text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-[#4338CA] focus-visible:ring-offset-2 outline-none"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{selectedFileIds.length > 1 ? 'Download Selected' : 'Download'}</span>
              </button>

              <button
                type="button"
                onClick={handleBatchDelete}
                disabled={isBatchProcessing}
                className="px-3 py-1.5 bg-[#FEF2F2] hover:bg-[#FEE2E2] text-[#DC2626] border border-[#FECACA] text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-[#DC2626] focus-visible:ring-offset-2 outline-none"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Selected</span>
              </button>

              <button
                type="button"
                onClick={() => setSelectedFileIds([])}
                className="p-1.5 text-[#94A3B8] hover:text-[#0F172A] rounded-lg focus-visible:ring-2 focus-visible:ring-[#4338CA] outline-none"
                title="Deselect all"
                aria-label="Deselect all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Code Phone Modal */}
      {qrModalOpen && (
        <div className="fixed inset-0 z-50 bg-[#0F172A]/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-[#E2E8F0] rounded-[14px] p-6 max-w-sm w-full shadow-lg relative text-center">
            <button
              type="button"
              onClick={() => setQrModalOpen(false)}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-[#94A3B8] hover:text-[#0F172A] hover:bg-[#F8FAFC] focus-visible:ring-2 focus-visible:ring-[#4338CA] outline-none"
              aria-label="Close modal"
            >
              <X className="w-4 h-4" />
            </button>

            <h3 className="text-base font-semibold text-[#0F172A]">Scan with phone camera</h3>
            <p className="text-xs text-[#475569] mt-0.5">
              Connect iPhone or Android on the same Wi-Fi.
            </p>

            <div className="mt-4 p-3 bg-white rounded-lg inline-block border border-[#E2E8F0]">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="QR Code for Pairing"
                  className="w-52 h-52 mx-auto rounded"
                />
              ) : (
                <div className="w-52 h-52 flex items-center justify-center text-xs text-[#94A3B8]">
                  Generating QR code…
                </div>
              )}
            </div>

            <div className="mt-4 p-2.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg text-left">
              <span className="text-[10px] text-[#475569] uppercase font-mono block">
                Pairing code
              </span>
              <span className="font-mono text-base font-bold text-[#4338CA]">
                {adminStatus?.pairingSecret || '------'}
              </span>
              <p className="text-[11px] text-[#475569] mt-0.5">
                The code is passed via URL fragment (#secret=…) to avoid web server logs.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* VCF Preview Modal */}
      {vcfPreview && (
        <div className="fixed inset-0 z-50 bg-[#0F172A]/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-[#E2E8F0] rounded-[14px] max-w-xl w-full max-h-[85vh] flex flex-col shadow-lg overflow-hidden">
            <div className="p-5 border-b border-[#E2E8F0] flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-[#0F172A]">Contact preview</h3>
                <p className="text-xs text-[#475569] font-mono mt-0.5">
                  {vcfPreview.filename} ({vcfPreview.totalContacts} parsed)
                </p>
              </div>
              <button
                type="button"
                onClick={() => setVcfPreview(null)}
                className="p-1.5 rounded-lg text-[#94A3B8] hover:text-[#0F172A] focus-visible:ring-2 focus-visible:ring-[#4338CA] outline-none"
                aria-label="Close preview"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 flex-1">
              {vcfPreview.duplicateCandidatesCount > 0 && (
                <div className="p-3 rounded-lg bg-[#FFFBEB] border border-[#FDE68A] text-[#D97706] text-xs">
                  <strong>{vcfPreview.duplicateCandidatesCount} possible duplicate contacts</strong> found with shared numbers or names.
                </div>
              )}

              {/* Import guidance */}
              <div className="bg-[#F8FAFC] p-3 rounded-lg border border-[#E2E8F0] text-xs text-[#475569] space-y-1">
                <span className="font-semibold text-[#0F172A] block">Device import:</span>
                <p>iPhone: Download file, open in Files / Safari Downloads, and tap "Add all contacts".</p>
                <p>Android: Download file, open Contacts app &gt; Settings &gt; Import from .vcf.</p>
              </div>

              {/* Contacts List */}
              <div className="space-y-2.5">
                {vcfPreview.contacts.map((contact, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg border border-[#E2E8F0] bg-white text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between font-semibold text-[#0F172A]">
                      <span>{contact.fn}</span>
                      {contact.isPossibleDuplicate && (
                        <span className="text-[10px] text-[#D97706] bg-[#FFFBEB] px-1.5 py-0.5 rounded border border-[#FDE68A]">
                          Possible duplicate
                        </span>
                      )}
                    </div>

                    {contact.phones.map((p, pIdx) => (
                      <div key={pIdx} className="text-[#475569] font-mono flex items-center gap-1.5">
                        <Phone className="w-3 h-3 text-[#4338CA]" />
                        <span>({p.type}) {p.value}</span>
                      </div>
                    ))}

                    {contact.emails.map((e, eIdx) => (
                      <div key={eIdx} className="text-[#475569] font-mono flex items-center gap-1.5">
                        <Mail className="w-3 h-3 text-[#4338CA]" />
                        <span className="truncate">{e.value}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="p-4 border-t border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between">
              <span className="text-[11px] text-[#475569]">Original file is untouched</span>
              <button
                type="button"
                onClick={() => setVcfPreview(null)}
                className="px-3 py-1.5 border border-[#E2E8F0] bg-white text-[#0F172A] hover:bg-[#F8FAFC] rounded-lg text-xs font-medium focus-visible:ring-2 focus-visible:ring-[#4338CA] outline-none"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
