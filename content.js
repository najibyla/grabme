(function () {
  "use strict";

  // =====================================================================
  // Dans l'iframe du player Vimeo (player.vimeo.com)
  // all_frames:true permet au script de tourner ici directement
  // =====================================================================
  if (location.hostname === "player.vimeo.com") {

    function sendCurrentTitle() {
      const title = document.title.replace(/\s*on Vimeo$/i, "").trim();
      if (title && title.toLowerCase() !== "vimeo") {
        chrome.runtime.sendMessage({ action: "vimeoFrameTitle", title });
      }
    }

    // Sélecteurs du DOM interne du player Vimeo (classnames obfusqués, plusieurs versions)
    const VIMEO_PLAYLIST_SEL = [
      ".playlist--title",
      ".vp-playlist-item-title",
      "[class*='playlist'] [class*='title']",
      "[class*='list-item'] [class*='title']",
      "[class*='clip'] [class*='title']",
    ];

    function sendPlaylistTitles() {
      for (const sel of VIMEO_PLAYLIST_SEL) {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length > 0) {
          const titles = Array.from(nodes).map(n => n.textContent.trim()).filter(Boolean);
          if (titles.length > 0) {
            chrome.runtime.sendMessage({ action: "vimeoPlaylistTitles", titles });
            return;
          }
        }
      }
    }

    function init() {
      sendCurrentTitle();
      sendPlaylistTitles();

      // Surveiller les changements de titre — se produit lors des navigations dans la playlist
      const titleEl = document.querySelector("title");
      if (titleEl) {
        new MutationObserver(sendCurrentTitle)
          .observe(titleEl, { childList: true, characterData: true, subtree: true });
      }

      // Surveiller le body pour les changements de playlist
      new MutationObserver(sendPlaylistTitles)
        .observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }

    return; // Ne pas exécuter le code de la page parente
  }

  // =====================================================================
  // Sur la page parente — extraction DOM des titres de playlist du site hôte
  // et interception postMessage du player Vimeo embarqué
  // =====================================================================

  const PLAYLIST_SELECTORS = [
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sendTitles);
  } else {
    sendTitles();
  }

  const observer = new MutationObserver(sendTitles);
  observer.observe(document.body, { childList: true, subtree: true });

  // Interception postMessage du player Vimeo (fallback si all_frames ne couvre pas ce cas)
  window.addEventListener("message", (event) => {
    try {
      const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      if (!data || data.context !== "Vimeo.Hub") return;
      if (["ready", "play"].includes(data.event)) {
        chrome.runtime.sendMessage({ action: "vimeoEvent", event: data.event, pageTitle: document.title });
        sendTitles();
      }
    } catch {
      // ignorer les messages non-JSON / non-Vimeo
    }
  });
})();
