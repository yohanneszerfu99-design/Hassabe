// firebase-messaging-sw.js
// Place this file in the ROOT of your Netlify frontend deployment.
// Netlify: put it in your frontend/ folder so it's served at hassabe.app/firebase-messaging-sw.js

importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-messaging-compat.js');

// Replace with your Firebase project config
firebase.initializeApp({
  apiKey:            "your-firebase-api-key",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project-id",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "your-sender-id",
  appId:             "your-app-id"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  const { title, body, icon, data } = payload.notification || {};
  self.registration.showNotification(title || 'Hassabe', {
    body:  body  || 'You have a new notification.',
    icon:  icon  || '/icon-192.png',
    badge: '/badge-72.png',
    tag:   data?.matchId || 'hassabe-notification',
    data:  data || {},
    actions: data?.matchId ? [{ action: 'open', title: 'Open' }] : [],
  });
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const matchId = event.notification.data?.matchId;
  const url = matchId ? `/matches?id=${matchId}` : '/';
  event.waitUntil(clients.openWindow(url));
});
