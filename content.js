// Content script — extrait les titres de la playlist Vimeo depuis le DOM de la page hôte
// et intercepte les événements postMessage du player Vimeo

(function () {
  "use strict";

  // Sélecteurs courants pour les listes de vidéos dans les sites qui embedent Vimeo
  const PLAYLIST_SELECTORS = [
    ".vp-playlist-item .vp-playlist-item-title",  // Player Vimeo natif
    "[class*='playlist'] [class*='title']",
    "[class*='video-list'] [class*='title']",
    "[class*='lesson'] [class*='title']",
    "[class*='chapter'] [class*='title']",
    "[class*='episode'] [class*='title']",
    "li [class*='title']",
  ];

  function extractPlaylistTitles() {
    for (const sel of PLAYLIST_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length > 1) {
        return Array.from(nodes).map(n => n.textContent.trim()).filter(Boolean);
      }
    }
    return [];
  }

  function sendTitles() {
    const titles = extractPlaylistTitles();
    if (titles.length > 0) {
      chrome.runtime.sendMessage({ action: "vimeoPlaylistTitles", titles });
    }
  }

  // Envoyer les titres dès que la page est prête
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sendTitles);
  } else {
    sendTitles();
  }

  // Surveiller les changements DOM (SPA — la playlist peut charger après le JS)
  const observer = new MutationObserver(() => sendTitles());
  observer.observe(document.body, { childList: true, subtree: true });

  // Intercepter les messages postMessage du player Vimeo embarqué
  window.addEventListener("message", (event) => {
    try {
      const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      if (!data || data.context !== "Vimeo.Hub") return;

      // Quand le player change de vidéo, renvoyer les titres + le titre courant
      if (["ready", "play", "loadProgress", "seeking"].includes(data.event)) {
        chrome.runtime.sendMessage({
          action: "vimeoEvent",
          event: data.event,
          pageTitle: document.title,
        });
        sendTitles();
      }
    } catch {
      // Ignorer les messages non-JSON ou non-Vimeo
    }
  });
})();
