(function configureApiBaseUrl() {
  const host = String(window.location.hostname || '').toLowerCase();
  const port = String(window.location.port || '');

  // Development frontend (livereload on :8080) does not provide /api proxy.
  // Route directly to the backend on the same machine/network host, while
  // keeping relative /api for production behind Nginx.
  if (port === '8080') {
    const backendHost = host === '0.0.0.0' ? 'localhost' : (host || 'localhost');
    window.API_BASE_URL = `${window.location.protocol}//${backendHost}:8000`;
    return;
  }

  window.API_BASE_URL = '/api';
})();
