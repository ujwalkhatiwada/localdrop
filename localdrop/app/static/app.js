// LocalDrop Vanilla JavaScript Client
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('file-input');
  const browseBtn = document.getElementById('browse-btn');
  const dropzone = document.getElementById('dropzone');
  const connectBtn = document.getElementById('connect-btn');
  const pinInput = document.getElementById('pin-input');
  const filesList = document.getElementById('files-list');
  const emptyState = document.getElementById('empty-state');
  const uploadContainer = document.getElementById('upload-progress-container');
  const uploadFilename = document.getElementById('upload-filename');
  const uploadProgressBar = document.getElementById('upload-progress-bar');
  const uploadStatusText = document.getElementById('upload-status-text');

  browseBtn.addEventListener('click', () => fileInput.click());

  // URL fragment redemption (#secret=...)
  const hash = window.location.hash;
  if (hash && hash.includes('secret=')) {
    const match = hash.match(/secret=([A-Za-z0-9]+)/);
    if (match && match[1]) {
      const secret = match[1];
      window.history.replaceState(null, '', window.location.pathname);
      pairWithSecret(secret);
    }
  }

  // Connect button
  connectBtn.addEventListener('click', () => {
    const secret = pinInput.value.trim();
    if (secret) pairWithSecret(secret);
  });

  async function pairWithSecret(secret) {
    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: secret.toUpperCase() })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        sessionStorage.setItem('localdrop_token', data.session_id || data.sessionId);
        loadFiles();
      } else {
        alert('That code is invalid or has expired. Check the code or ask the owner for a new one.');
      }
    } catch (e) {
      alert('That code is invalid or has expired. Check the code or ask the owner for a new one.');
    }
  }

  // Dropzone drag-and-drop
  ['dragenter', 'dragover'].forEach(event => {
    dropzone.addEventListener(event, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(event => {
    dropzone.addEventListener(event, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files.length) uploadFiles(dt.files);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFiles(fileInput.files);
  });

  function uploadFiles(fileList) {
    Array.from(fileList).forEach(file => {
      const formData = new FormData();
      formData.append('file', file);

      const xhr = new XMLHttpRequest();
      uploadContainer.style.display = 'block';
      uploadFilename.textContent = file.name;
      uploadStatusText.textContent = 'Uploading…';

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
          uploadProgressBar.style.width = percent + '%';
          uploadStatusText.textContent = percent === 100 ? 'Finishing…' : 'Uploading…';
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          uploadStatusText.textContent = 'File ready to share';
          setTimeout(() => {
            uploadContainer.style.display = 'none';
            uploadProgressBar.style.width = '0%';
          }, 2000);
          loadFiles();
        } else if (xhr.status === 401) {
          uploadStatusText.textContent = 'Upload failed. Try again.';
          alert('Your session has expired. Reconnect using a new pairing code.');
        } else {
          uploadStatusText.textContent = 'Upload failed. Try again.';
        }
      });

      xhr.addEventListener('error', () => {
        uploadStatusText.textContent = 'Upload failed. Try again.';
      });

      xhr.open('POST', '/api/files');
      const token = sessionStorage.getItem('localdrop_token');
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.send(formData);
    });
  }

  async function loadFiles() {
    try {
      const headers = {};
      const token = sessionStorage.getItem('localdrop_token');
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const res = await fetch('/api/files', { headers });
      if (res.ok) {
        const data = await res.json();
        renderFiles(data.files || []);
      } else if (res.status === 401) {
        alert('Your session has expired. Reconnect using a new pairing code.');
      }
    } catch (e) {}
  }

  function renderFiles(files) {
    if (!files || files.length === 0) {
      emptyState.style.display = 'block';
      return;
    }
    emptyState.style.display = 'none';
    filesList.innerHTML = '';

    files.forEach(file => {
      const row = document.createElement('div');
      row.className = 'file-row';

      const info = document.createElement('div');
      info.className = 'file-info';

      const fileNameText = file.originalName || file.original_name || 'unnamed_file';
      const name = document.createElement('div');
      name.className = 'file-name';
      name.title = fileNameText;
      name.textContent = fileNameText;

      const meta = document.createElement('div');
      meta.className = 'file-meta';
      meta.textContent = (file.size ? (file.size / 1024 / 1024).toFixed(2) + ' MB' : '');

      info.appendChild(name);
      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'file-actions';

      const downloadLink = document.createElement('a');
      downloadLink.href = '/api/files/' + file.id + '/download';
      downloadLink.className = 'btn-secondary';
      downloadLink.textContent = 'Download';
      downloadLink.setAttribute('download', fileNameText);

      actions.appendChild(downloadLink);

      row.appendChild(info);
      row.appendChild(actions);
      filesList.appendChild(row);
    });
  }

  loadFiles();
});
