self.addEventListener('install', event => {
  self.skipWaiting();
});
self.addEventListener('fetch', event => {
  // basta per rendere l'app installabile
});
