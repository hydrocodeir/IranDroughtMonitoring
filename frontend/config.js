(function configureApiBaseUrl() {
  const host = String(window.location.hostname || '').toLowerCase();
  const port = String(window.location.port || '');
  const isLocalHost = host === 'localhost' || host === '127.0.0.1';

  // Development frontend (livereload on :8080) does not provide /api proxy.
  // Route directly to backend when running locally, keep relative /api elsewhere
  // so production Nginx proxy continues to work.
  window.API_BASE_URL = (isLocalHost && port === '8080') ? 'http://localhost:8000' : '/api';
})();
